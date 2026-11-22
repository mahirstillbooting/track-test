/*
  =============================================================================
  PROJECT CHALOK - UPDATED CHALOK TEST V1 (ROCK-SOLID BUZZER & POWER EDITION)
  =============================================================================
  Target Board: ESP32 Dev Module
  Libraries   : LiquidCrystal_I2C, TinyGPSPlus, Wire, SPI, SD, WiFi, HTTPClient

  Hardware Physical LED Pinout (Hardware Verified):
    - GPIO 4  = GREEN LED  (Active Ride Sharing Indicator)
    - GPIO 5  = BLUE LED   (GPS 3D Fix & Cloud Link Indicator)
    - GPIO 18 = ORANGE LED (Telemetry Transmission Pulse - flashes on TX)
    - GPIO 19 = RED LED    (Standby Heartbeat Pulse)

  Buzzer Architecture & Anti-Stall Protection:
    - Active Piezo Buzzer on GPIO 25.
    - Uses non-blocking triggerBuzzerChirp(count, durationMs) engine from low-power edition.
    - Crisp 45ms tactile pips with 60ms gap.
    - HARD SAFETY CLAMP: Buzzer pin is unconditionally forced LOW before ANY HTTP/network
      call so if the cloud does not react or drops the packet, the buzzer CAN NEVER
      get stuck screaming loudly on HIGH!
    - Network timeout clamped to 1200ms to prevent loop stalling.

  Button Roles & Zero-Conflict State Logic:
    - BUTTON 1 (GPIO 23):
        * Short Click (< 2s) : Starts live sharing (only if stopped).
                               If sharing is ALREADY active, short click does NOTHING!
        * 2-Second Hold (>=2s): Toggles LCD backlight ON/OFF.
                               Uses holdHandled flag: releasing B1 NEVER stops sharing!
    - BUTTON 2 (GPIO 32):
        * Short Click (< 2s) : The ONLY button that STOPS live sharing / enters Standby.

  Indoor Testing & Assisted GPS:
    - If GPS satellites are not locked (indoor testing in room), uses valid Dhaka fallback
      coordinates (23.718382, 90.384001) so LCD and web map always work cleanly.
    - Seamlessly updates to high-precision live coordinates once outdoor fix is acquired.
  =============================================================================
*/

#include <Arduino.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <TinyGPS++.h>
#include <SPI.h>
#include <SD.h>
#include <WiFi.h>
#include <HTTPClient.h>

// ======================================================
// PIN DEFINITIONS
// ======================================================
constexpr uint8_t GPS_RX  = 16;
constexpr uint8_t GPS_TX  = 17;
constexpr uint8_t SDA_PIN = 21;
constexpr uint8_t SCL_PIN = 22;

// 4 Verified Physical LEDs
constexpr uint8_t LED_GREEN  = 4;   // GPIO 4  = GREEN  (Active Sharing)
constexpr uint8_t LED_BLUE   = 5;   // GPIO 5  = BLUE   (GPS Fix / Network)
constexpr uint8_t LED_ORANGE = 18;  // GPIO 18 = ORANGE (Data TX Pulse)
constexpr uint8_t LED_RED    = 19;  // GPIO 19 = RED    (Standby Heartbeat)

constexpr uint8_t LED_PINS[] = {LED_GREEN, LED_BLUE, LED_ORANGE, LED_RED};
constexpr uint8_t LED_COUNT  = sizeof(LED_PINS) / sizeof(LED_PINS[0]);

constexpr uint8_t BUZZER_PIN = 25;  // Active Piezo Buzzer (Active HIGH)
constexpr uint8_t BUTTON_1   = 23;  // START Sharing / 2s Hold -> LCD Backlight
constexpr uint8_t BUTTON_2   = 32;  // STOP Sharing immediately

// MicroSD Card SPI Bus
constexpr uint8_t SD_SCK  = 14;
constexpr uint8_t SD_MISO = 27;
constexpr uint8_t SD_MOSI = 26;
constexpr uint8_t SD_CS   = 13;

// ======================================================
// WI-FI & FIREBASE CONFIGURATION
// ======================================================
const char *WIFI_SSID     = "chalok_device1";
const char *WIFI_PASSWORD = "chalokapp";
constexpr uint32_t WIFI_RETRY_MS = 10000;

const char *FIREBASE_HOST = "https://track-test-4ddde-default-rtdb.asia-southeast1.firebasedatabase.app";
constexpr uint32_t FIREBASE_TELEMETRY_INTERVAL_MS = 3000; // 3-second cycle

// I2C Addresses
constexpr uint8_t LCD_ADDRESS = 0x27;
constexpr uint8_t LCD_COLS    = 16;
constexpr uint8_t LCD_ROWS    = 2;
constexpr uint8_t MPU_ADDRESS = 0x68;

// Timing Constants
constexpr uint32_t GPS_TIMEOUT_MS    = 5000;
constexpr uint32_t PAGE_TIME_MS      = 2800;
constexpr uint32_t CONFIRM_MSG_MS    = 1800; // 1.8s confirmation display
constexpr uint32_t LOG_INTERVAL_MS   = 15000;
constexpr uint32_t HOLD_BACKLIGHT_MS = 2000; // Hold Button 1 for 2s to toggle backlight

// ======================================================
// OBJECTS & STATE
// ======================================================
LiquidCrystal_I2C lcd(LCD_ADDRESS, LCD_COLS, LCD_ROWS);
HardwareSerial gpsPort(2);
TinyGPSPlus gps;

enum Page {
  LCD_INFO,
  WIFI_STATUS,
  GPS_STATUS,
  GPS_COORDS,
  MPU_TILT,
  MPU_ACCEL_XYZ,
  BUTTONS,
  OUTPUTS,
  PAGE_COUNT
};

struct Button {
  uint8_t  pin;
  bool     rawPressed;
  bool     pressed;
  uint32_t changedAt;
  uint32_t presses;
  uint32_t pressedAt;
  bool     holdHandled;
};

Button buttons[] = {
  {BUTTON_1, false, false, 0, 0, 0, false},
  {BUTTON_2, false, false, 0, 0, 0, false}
};

bool sharingActive     = false; // Standby on boot; starts sharing ONLY when Button 1 is pressed
bool pendingActiveSync = true;  // Syncs 'false' to Firebase on boot
bool wasWifiConnected  = false;
bool lcdFound          = false;
bool lcdBacklightState = true;  // Controlled by 2-second hold on Button 1
bool mpuReady          = false;
bool mpuSampleValid    = false;

float tiltDegrees   = 0.0f;
float rollXDegrees  = 0.0f;
float pitchYDegrees = 0.0f;
float accelXg       = 0.0f;
float accelYg       = 0.0f;
float accelZg       = 0.0f;

// Fallback Dhaka coordinates for indoor testing without satellite lock
double lastKnownLat = 23.718382;
double lastKnownLng = 90.384001;

bool wifiStarted               = false;
uint32_t lastWifiAttemptAt     = 0;
bool gpsReceived               = false;
uint32_t lastGpsByteAt         = 0;
uint32_t lastNmeaAt            = 0;
uint32_t lastMpuAt             = 0;
uint32_t lastLcdAt             = 0;
uint32_t lastFirebaseTelemetryAt = 0;
uint32_t lastLedPatternAt      = 0;
uint32_t pageSince             = 0;
Page page                      = LCD_INFO;

// ======================================================
// NON-BLOCKING TACTILE BUZZER ENGINE (WITH SAFETY CLAMP)
// ======================================================
bool     buzzerActive   = false;
uint8_t  beepsPending   = 0;
uint32_t buzzerEndTime  = 0;
uint32_t nextBeepAt     = 0;

void triggerBuzzerChirp(uint8_t count, uint16_t durationMs = 45) {
  beepsPending   = count;
  nextBeepAt     = millis();
  buzzerEndTime  = millis() + durationMs;
}

void updateBuzzer(uint32_t now) {
  if (buzzerActive && now >= buzzerEndTime) {
    digitalWrite(BUZZER_PIN, LOW);
    buzzerActive = false;
    nextBeepAt   = now + 60; // 60ms gap between pips
  } else if (!buzzerActive && beepsPending > 0 && now >= nextBeepAt) {
    --beepsPending;
    digitalWrite(BUZZER_PIN, HIGH);
    buzzerActive  = true;
    buzzerEndTime = now + 45; // 45ms crisp tactile chirp
  }
}

// HARD SAFETY SHUTOFF: Always call before network operations
void forceBuzzerOff() {
  digitalWrite(BUZZER_PIN, LOW);
  buzzerActive = false;
  beepsPending = 0;
}

// ======================================================
// LCD CONFIRMATION HELPER
// ======================================================
bool showConfirmMessage   = false;
uint32_t confirmMessageAt = 0;
char confirmTop[17]       = "";
char confirmBottom[17]    = "";

void lcdLine(uint8_t row, const char *line);

void lcdConfirmation(const char *top, const char *bottom) {
  strncpy(confirmTop, top, sizeof(confirmTop) - 1);
  confirmTop[sizeof(confirmTop) - 1] = '\0';
  strncpy(confirmBottom, bottom, sizeof(confirmBottom) - 1);
  confirmBottom[sizeof(confirmBottom) - 1] = '\0';
  confirmMessageAt   = millis();
  showConfirmMessage = true;
  lcdLine(0, confirmTop);
  lcdLine(1, confirmBottom);
}

// ======================================================
// FIREBASE REST API HELPERS (WITH ANTI-STALL TIMEOUT)
// ======================================================
bool firebasePUT(const String &path, const String &json) {
  if (WiFi.status() != WL_CONNECTED) return false;

  // SAFETY: Silence buzzer BEFORE entering network wait so it never screams!
  digitalWrite(BUZZER_PIN, LOW);
  buzzerActive = false;

  HTTPClient http;
  String url = String(FIREBASE_HOST) + path + ".json";
  http.begin(url);
  http.setTimeout(1200); // 1.2s tight timeout prevents loop stalling
  http.addHeader("Content-Type", "application/json");

  int httpCode = http.PUT(json);
  http.end();

  // Safety ensure buzzer stays off after network call
  digitalWrite(BUZZER_PIN, LOW);
  return (httpCode >= 200 && httpCode < 300);
}

void syncActiveStatusToFirebase() {
  forceBuzzerOff();

  bool ok = false;
  if (WiFi.status() == WL_CONNECTED) {
    String json = sharingActive ? "true" : "false";
    ok = firebasePUT("/tracker/active", json);
  }

  // Provide crisp confirmation beeps ONLY AFTER network call has finished
  if (sharingActive) {
    triggerBuzzerChirp(2, 45); // 2 crisp pips for START
    lcdConfirmation("RIDE: ACTIVE", ok ? "Cloud Confirmed" : "Local Active");
  } else {
    triggerBuzzerChirp(3, 45); // 3 crisp pips for STOP
    lcdConfirmation("RIDE: STOPPED", ok ? "Cloud Confirmed" : "Local Standby");
  }
}

// ======================================================
// I2C & MPU-6050 ROUTINES
// ======================================================
bool i2cPresent(uint8_t address) {
  Wire.beginTransmission(address);
  return Wire.endTransmission() == 0;
}

bool readMpu(uint8_t reg, uint8_t *data, uint8_t size) {
  Wire.beginTransmission(MPU_ADDRESS);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0 || Wire.requestFrom(MPU_ADDRESS, size) != size) {
    return false;
  }
  for (uint8_t i = 0; i < size; ++i) data[i] = Wire.read();
  return true;
}

bool writeMpu(uint8_t reg, uint8_t value) {
  Wire.beginTransmission(MPU_ADDRESS);
  Wire.write(reg);
  Wire.write(value);
  return Wire.endTransmission() == 0;
}

void sampleMpu() {
  if (!mpuReady) {
    uint8_t id = 0;
    if (!readMpu(0x75, &id, 1) || (id != 0x68 && id != 0x70) ||
        !writeMpu(0x6B, 0x01) || !writeMpu(0x1C, 0x00)) {
      return;
    }
    mpuReady = true;
    return;
  }

  uint8_t raw[6];
  if (!readMpu(0x3B, raw, sizeof(raw))) {
    mpuReady = false;
    mpuSampleValid = false;
    return;
  }
  const float x = static_cast<int16_t>((raw[0] << 8) | raw[1]);
  const float y = static_cast<int16_t>((raw[2] << 8) | raw[3]);
  const float z = static_cast<int16_t>((raw[4] << 8) | raw[5]);

  accelXg = x / 16384.0f;
  accelYg = y / 16384.0f;
  accelZg = z / 16384.0f;

  rollXDegrees  = atan2f(y, z) * RAD_TO_DEG;
  pitchYDegrees = atan2f(-x, sqrtf(y * y + z * z)) * RAD_TO_DEG;
  tiltDegrees   = atan2f(hypotf(x, y), z) * RAD_TO_DEG;
  mpuSampleValid = (x != 0 || y != 0 || z != 0);
}

// ======================================================
// WI-FI CONNECTION (LOW CURRENT PEAKS @ 15 dBm)
// ======================================================
void updateWifi(uint32_t now) {
  bool currentConnected = (WiFi.status() == WL_CONNECTED);

  if (!wifiStarted) {
    WiFi.persistent(false);
    WiFi.mode(WIFI_STA);
    WiFi.setTxPower(WIFI_POWER_15dBm); // 15dBm eliminates modem current droop
    WiFi.setAutoReconnect(true);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    wifiStarted = true;
    lastWifiAttemptAt = now;
  } else if (!currentConnected && (now - lastWifiAttemptAt >= WIFI_RETRY_MS)) {
    lastWifiAttemptAt = now;
    wl_status_t st = WiFi.status();
    if (st == WL_CONNECT_FAILED || st == WL_CONNECTION_LOST || st == WL_NO_SSID_AVAIL) {
      WiFi.disconnect();
      WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    }
  }

  if (currentConnected && !wasWifiConnected) {
    pendingActiveSync = true;
    lcdConfirmation("WiFi CONNECTED", "Online");
    triggerBuzzerChirp(1, 40); // 1 gentle pip on successful connection
  }
  wasWifiConnected = currentConnected;
}

// ======================================================
// GPS PARSER & DIAGNOSTICS
// ======================================================
void readGps() {
  while (gpsPort.available()) {
    gpsReceived = true;
    lastGpsByteAt = millis();
    if (gps.encode(gpsPort.read())) {
      lastNmeaAt = lastGpsByteAt;
    }
  }
}

bool gpsHasNmea(uint32_t now) {
  return gps.passedChecksum() > 0 && now - lastNmeaAt < GPS_TIMEOUT_MS;
}

bool gpsHasFix(uint32_t now) {
  return gpsHasNmea(now) && gps.location.isValid() && gps.location.age() < GPS_TIMEOUT_MS;
}

const char *gpsStatus(uint32_t now) {
  if (gpsHasFix(now)) return "Fix OK";
  if (gpsHasNmea(now)) return "Indoor/Assisted";
  if (gpsReceived && now - lastGpsByteAt < GPS_TIMEOUT_MS) return "No valid NMEA";
  return "No UART data";
}

// ======================================================
// 4 STATUS LEDS CONTROLLER (VERIFIED PHYSICAL PINS)
// ======================================================
void updateStatusLeds(uint32_t now) {
  if (now - lastLedPatternAt < 250) return;
  lastLedPatternAt = now;

  static uint8_t activeStep = 0;
  bool hasFix   = gpsHasFix(now);
  bool isWifiOk = (WiFi.status() == WL_CONNECTED);

  if (sharingActive) {
    // ACTIVE SHARING:
    // RED (GPIO 19) is completely OFF
    digitalWrite(LED_RED, LOW);

    // GREEN (GPIO 4) & BLUE (GPIO 5) alternate in active ride chase pattern
    activeStep = (activeStep + 1) % 4;
    digitalWrite(LED_GREEN, (activeStep == 0 || activeStep == 1) ? HIGH : LOW);
    digitalWrite(LED_BLUE,  (hasFix && isWifiOk) ? HIGH : ((activeStep == 2 || activeStep == 3) ? HIGH : LOW));

    // ORANGE (GPIO 18) stays on when Wi-Fi ready, flashes on TX
    digitalWrite(LED_ORANGE, isWifiOk ? HIGH : LOW);
  } else {
    // STANDBY / STOPPED:
    // RED (GPIO 19) slow 1 Hz heartbeat pulse
    static bool redBlink = false;
    redBlink = !redBlink;
    digitalWrite(LED_RED, redBlink ? HIGH : LOW);

    // GREEN (GPIO 4), BLUE (GPIO 5), ORANGE (GPIO 18) are completely OFF
    digitalWrite(LED_GREEN, LOW);
    digitalWrite(LED_BLUE, LOW);
    digitalWrite(LED_ORANGE, LOW);
  }
}

// ======================================================
// TELEMETRY TRANSMITTER (FIREBASE LIVE SYNC - 3s CYCLE)
// ======================================================
void updateFirebaseTelemetry(uint32_t now) {
  if (WiFi.status() != WL_CONNECTED) return;

  if (pendingActiveSync) {
    syncActiveStatusToFirebase();
    pendingActiveSync = false;
  }

  // If sharing is stopped, DO NOT send telemetry (saves data & battery)
  if (!sharingActive) return;
  if (now - lastFirebaseTelemetryAt < FIREBASE_TELEMETRY_INTERVAL_MS) return;
  lastFirebaseTelemetryAt = now;

  double lat = lastKnownLat;
  double lng = lastKnownLng;
  uint32_t satellites = 0;

  if (gps.location.isValid()) {
    lat = gps.location.lat();
    lng = gps.location.lng();
    lastKnownLat = lat;
    lastKnownLng = lng;
  }
  if (gps.satellites.isValid()) {
    satellites = gps.satellites.value();
  }

  // Flash ORANGE LED (GPIO 18) during transmission
  digitalWrite(LED_ORANGE, HIGH);

  uint64_t epochMs = 0;
  if (gps.date.isValid() && gps.time.isValid() && gps.date.year() >= 2024) {
    struct tm t = {};
    t.tm_year = gps.date.year() - 1900;
    t.tm_mon  = gps.date.month() - 1;
    t.tm_mday = gps.date.day();
    t.tm_hour = gps.time.hour();
    t.tm_min  = gps.time.minute();
    t.tm_sec  = gps.time.second();
    t.tm_isdst = 0;
    time_t epochSec = mktime(&t);
    if (epochSec > 0) {
      epochMs = ((uint64_t)epochSec) * 1000ULL + (gps.time.centisecond() * 10);
    }
  }

  String payload = "{";
  payload += "\"lat\":" + String(lat, 6) + ",";
  payload += "\"lng\":" + String(lng, 6) + ",";
  payload += "\"satellites\":" + String(satellites) + ",";
  payload += "\"tilt\":" + String(tiltDegrees, 1) + ",";
  payload += "\"roll\":" + String(rollXDegrees, 1) + ",";
  payload += "\"pitch\":" + String(pitchYDegrees, 1) + ",";
  payload += "\"ax\":" + String(accelXg, 2) + ",";
  payload += "\"ay\":" + String(accelYg, 2) + ",";
  payload += "\"az\":" + String(accelZg, 2) + ",";
  if (epochMs > 0) {
    char epochBuf[24];
    snprintf(epochBuf, sizeof(epochBuf), "%llu", (unsigned long long)epochMs);
    payload += "\"timestamp\":" + String(epochBuf) + ",";
  } else {
    payload += "\"timestamp\":" + String(now) + ",";
  }
  payload += "\"deviceMillis\":" + String(now);
  payload += "}";

  firebasePUT("/tracker/current", payload);
}

// ======================================================
// LCD UI & BACKLIGHT ENGINE
// ======================================================
void showPage(Page next) {
  page = next;
  pageSince = millis();
}

void lcdLine(uint8_t row, const char *line) {
  if (!lcdFound) return;
  char padded[LCD_COLS + 1];
  snprintf(padded, sizeof(padded), "%-*.*s", LCD_COLS, LCD_COLS, line);
  lcd.setCursor(0, row);
  lcd.print(padded);
}

void refreshLcd(uint32_t now) {
  if (!lcdFound) return;

  if (showConfirmMessage) {
    if (now - confirmMessageAt >= CONFIRM_MSG_MS) {
      showConfirmMessage = false;
    } else {
      lcdLine(0, confirmTop);
      lcdLine(1, confirmBottom);
      return;
    }
  }

  if (now - pageSince >= PAGE_TIME_MS) {
    page = static_cast<Page>((page + 1) % PAGE_COUNT);
    pageSince = now;
  }

  char top[17] = "";
  char bottom[17] = "";

  switch (page) {
    case LCD_INFO:
      snprintf(top, sizeof(top), "CHALOK TRACKER");
      snprintf(bottom, sizeof(bottom), "RIDE: %s", sharingActive ? "ACTIVE" : "STANDBY");
      break;

    case WIFI_STATUS:
      snprintf(top, sizeof(top), "WiFi: %s", (WiFi.status() == WL_CONNECTED) ? "ONLINE" : "SEARCHING");
      snprintf(bottom, sizeof(bottom), "%s", (WiFi.status() == WL_CONNECTED) ? WIFI_SSID : "Connecting...");
      break;

    case GPS_STATUS:
      snprintf(top, sizeof(top), "GPS: %s", gpsStatus(now));
      snprintf(bottom, sizeof(bottom), "Sats: %lu", static_cast<unsigned long>(gps.satellites.value()));
      break;

    case GPS_COORDS:
      snprintf(top, sizeof(top), "Lat: %.5f", lastKnownLat);
      snprintf(bottom, sizeof(bottom), "Lon: %.5f", lastKnownLng);
      break;

    case MPU_TILT:
      snprintf(top, sizeof(top), "Tilt: %.1f deg", tiltDegrees);
      snprintf(bottom, sizeof(bottom), "Pitch: %.1f deg", pitchYDegrees);
      break;

    case MPU_ACCEL_XYZ:
      snprintf(top, sizeof(top), "X:%.1f Y:%.1f", accelXg, accelYg);
      snprintf(bottom, sizeof(bottom), "Z:%.1f g", accelZg);
      break;

    case BUTTONS:
      snprintf(top, sizeof(top), "B1:START B2:STOP");
      snprintf(bottom, sizeof(bottom), "Hold B1:LCD BL");
      break;

    case OUTPUTS:
      snprintf(top, sizeof(top), "STATUS: %s", sharingActive ? "ACTIVE" : "STANDBY");
      snprintf(bottom, sizeof(bottom), "LCD BL: %s", lcdBacklightState ? "ON" : "OFF");
      break;

    case PAGE_COUNT:
      break;
  }
  lcdLine(0, top);
  lcdLine(1, bottom);
}

// ======================================================
// BUTTONS & 2-SECOND HOLD BACKLIGHT ENGINE (ZERO CONFLICTS)
// ======================================================
void readButtons(uint32_t now) {
  for (uint8_t i = 0; i < 2; ++i) {
    Button &button = buttons[i];
    bool pressed = (digitalRead(button.pin) == LOW);

    // Track raw electrical bounce
    if (pressed != button.rawPressed) {
      button.rawPressed = pressed;
      button.changedAt = now;
    }

    // Debounce filter (35ms)
    if (now - button.changedAt < 35) {
      // While debouncing, if Button 1 is held down, continuously evaluate 2s hold condition
      if (button.pressed && i == 0 && !button.holdHandled) {
        if (now - button.pressedAt >= HOLD_BACKLIGHT_MS) {
          button.holdHandled = true;
          lcdBacklightState = !lcdBacklightState;
          if (lcdFound) {
            if (lcdBacklightState) lcd.backlight();
            else lcd.noBacklight();
          }
          triggerBuzzerChirp(1, 40); // 1 crisp tactile chirp
          lcdConfirmation("LCD BACKLIGHT", lcdBacklightState ? "Turned ON" : "Turned OFF");
          Serial.printf("[LCD] 2s Hold on B1 -> Backlight %s (Sharing State Unaltered: %s)\n",
                        lcdBacklightState ? "ON" : "OFF", sharingActive ? "ACTIVE" : "STOPPED");
        }
      }
      continue;
    }

    // Debounced state transition
    if (pressed != button.pressed) {
      button.pressed = pressed;

      if (button.pressed) {
        // --- BUTTON JUST PRESSED DOWN ---
        button.pressedAt   = now;
        button.holdHandled = false;
        ++button.presses;

        // BUTTON 2 (GPIO 32): Immediate Single Click -> STOP Sharing
        if (i == 1) {
          if (sharingActive) {
            sharingActive = false;
            pendingActiveSync = true;
            triggerBuzzerChirp(1, 30); // Instant tactile button feedback
            lcdConfirmation("STOP SHARING", "Syncing...");
            Serial.println("[BUTTON] Button 2 Pressed -> STOPPING Live Sharing!");
          }
        }
      } else {
        // --- BUTTON RELEASED ---
        uint32_t pressDuration = now - button.pressedAt;

        // BUTTON 1 (GPIO 23): Single Click -> START Sharing
        if (i == 0) {
          // If Button 1 was held for 2 seconds to toggle LCD backlight,
          // holdHandled is TRUE -> WE DO ABSOLUTELY NOTHING ON RELEASE!
          if (!button.holdHandled && pressDuration >= 40) {
            // Short click occurred (< 2000 ms)
            if (!sharingActive) {
              sharingActive = true;
              pendingActiveSync = true;
              triggerBuzzerChirp(1, 30); // Instant tactile button feedback
              lcdConfirmation("START SHARING", "Syncing...");
              Serial.println("[BUTTON] Button 1 Short Click -> STARTING Live Sharing!");
            } else {
              Serial.println("[BUTTON] Button 1 Short Click ignored (Sharing already Active). Use Button 2 to Stop.");
            }
          }
        }

        button.holdHandled = false;
        showPage(BUTTONS);
      }
    } else {
      // Button remains continuously held down
      if (button.pressed && i == 0 && !button.holdHandled) {
        if (now - button.pressedAt >= HOLD_BACKLIGHT_MS) {
          button.holdHandled = true;
          lcdBacklightState = !lcdBacklightState;
          if (lcdFound) {
            if (lcdBacklightState) lcd.backlight();
            else lcd.noBacklight();
          }
          triggerBuzzerChirp(1, 40); // 1 crisp tactile chirp
          lcdConfirmation("LCD BACKLIGHT", lcdBacklightState ? "Turned ON" : "Turned OFF");
          Serial.printf("[LCD] 2s Hold on B1 -> Backlight %s (Sharing State Unaltered: %s)\n",
                        lcdBacklightState ? "ON" : "OFF", sharingActive ? "ACTIVE" : "STOPPED");
        }
      }
    }
  }
}

// ======================================================
// ARDUINO SETUP & LOOP
// ======================================================
void setup() {
  Serial.begin(115200);
  delay(100);
  Serial.println("\n[INIT] UPDATED CHALOK TEST V1 (BUZZER-SAFE) STARTING...");

  for (uint8_t pin : LED_PINS) {
    pinMode(pin, OUTPUT);
    digitalWrite(pin, LOW);
  }

  // Initialize Buzzer strictly LOW
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);

  for (const Button &button : buttons) {
    pinMode(button.pin, INPUT_PULLUP);
  }

  Wire.begin(SDA_PIN, SCL_PIN, 100000);
  Wire.setTimeOut(40);
  lcdFound = i2cPresent(LCD_ADDRESS);
  if (lcdFound) {
    lcd.init();
    lcd.backlight();
    lcdBacklightState = true;
    lcd.clear();
    lcd.setCursor(0, 0);
    lcd.print("CHALOK TEST V1");
    lcd.setCursor(0, 1);
    lcd.print("Starting...");
  }

  // Power-safe Wi-Fi Initialization
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setTxPower(WIFI_POWER_15dBm); // 15dBm eliminates modem current droop / brownouts
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  wifiStarted = true;
  lastWifiAttemptAt = millis();

  gpsPort.setRxBufferSize(1024);
  gpsPort.begin(9600, SERIAL_8N1, GPS_RX, GPS_TX);

  // Turn ON Red Standby LED (GPIO 19) on boot
  digitalWrite(LED_RED, HIGH);
  showPage(LCD_INFO);
  refreshLcd(millis());

  // 1 gentle boot chirp
  triggerBuzzerChirp(1, 45);
}

void loop() {
  readGps();

  uint32_t now = millis();
  updateWifi(now);
  updateStatusLeds(now);
  readButtons(now);

  now = millis();
  if (now - lastMpuAt >= 200) {
    lastMpuAt = now;
    sampleMpu();
  }

  updateFirebaseTelemetry(now);

  // High-priority non-blocking buzzer engine
  updateBuzzer(millis());

  now = millis();
  if (now - lastLcdAt >= 200) {
    lastLcdAt = now;
    refreshLcd(now);
  }
}
