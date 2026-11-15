/*
  =============================================================================
  CHALOK LIVE GPS TRACKER - UBER-STYLE TELEMETRY & HARDWARE CONTROLLER
  =============================================================================
  Board: ESP32 Dev Module (classic ESP32 with GPIO16/17 available)
  Libraries: LiquidCrystal_I2C, TinyGPSPlus, Wire, SPI, SD, WiFi, HTTPClient

  Hardware Pinout:
    - GPS NEO-M8N: RX2=GPIO16 (ESP32 RX <- GPS TX), TX2=GPIO17 (ESP32 TX -> GPS RX)
    - I2C Bus: SDA=GPIO21, SCL=GPIO22 (Shared by LCD 0x27 and MPU6050 0x68)
    - 4 Status LEDs:
        * RED_LED    = GPIO4  (Stopped / Standby blink)
        * GREEN_LED  = GPIO5  (Active Sharing blink)
        * BLUE_LED   = GPIO18 (Network & GPS Fix indicator)
        * YELLOW_LED = GPIO19 (Data TX pulse)
    - Active Buzzer: GPIO25 (Active HIGH, 2 beeps on Start, 3 beeps on Stop, 1 on Backlight)
    - Push Buttons (to GND with internal PULLUP):
        * BUTTON_1 = GPIO23 (START Live Sharing | 4 Taps: Toggle LCD Backlight ON/OFF)
        * BUTTON_2 = GPIO32 (STOP Live Sharing)
    - MicroSD SPI: SCK=GPIO14, MISO=GPIO27, MOSI=GPIO26, CS=GPIO13
    - Master Power: Hardware toggle switch

  Telemetry & Power Stability:
    - RF TX power stabilized at 15dBm to avoid modem / battery brownouts.
    - 3-second telemetry update sends: lat, lng, satellites, tilt, roll, pitch, ax, ay, az, timestamp.
    - Speed is computed smoothly on web app from coordinate movements (relieves ESP32 load).
  =============================================================================
*/

#include <Arduino.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <TinyGPS++.h>
#include <SPI.h>
#include <SD.h>
#include <esp_random.h>
#include <WiFi.h>
#include <HTTPClient.h>

// ======================================================
// PIN DEFINITIONS
// ======================================================
constexpr uint8_t GPS_RX = 16;
constexpr uint8_t GPS_TX = 17;
constexpr uint8_t SDA_PIN = 21;
constexpr uint8_t SCL_PIN = 22;

// 4 Status LEDs
constexpr uint8_t LED_RED    = 4;
constexpr uint8_t LED_GREEN  = 5;
constexpr uint8_t LED_BLUE   = 18;
constexpr uint8_t LED_YELLOW = 19;
constexpr uint8_t LED_PINS[] = {LED_RED, LED_GREEN, LED_BLUE, LED_YELLOW};
constexpr uint8_t LED_COUNT  = sizeof(LED_PINS) / sizeof(LED_PINS[0]);

constexpr uint8_t BUZZER_PIN = 25;
constexpr uint8_t BUTTON_1   = 23;  // START SHARING / 4-TAP LCD TOGGLE
constexpr uint8_t BUTTON_2   = 32;  // STOP SHARING

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
constexpr uint32_t FIREBASE_TELEMETRY_INTERVAL_MS = 3000; // 3-second cycle (modem/battery safe)

// LCD & MPU Configuration
constexpr uint8_t LCD_ADDRESS = 0x27;
constexpr uint8_t LCD_COLS    = 16;
constexpr uint8_t LCD_ROWS    = 2;
constexpr uint8_t MPU_ADDRESS = 0x68;

// Timing Constants
constexpr uint32_t GPS_TIMEOUT_MS  = 5000;
constexpr uint32_t PAGE_TIME_MS    = 2800;
constexpr uint32_t BEEP_ON_MS      = 60;   // 60ms crisp pip
constexpr uint32_t BEEP_GAP_MS     = 60;   // 60ms gap between pips
constexpr uint32_t CONFIRM_MSG_MS  = 1800; // 1.8s confirmation display
constexpr uint32_t LOG_INTERVAL_MS = 15000;
constexpr uint32_t SD_MESSAGE_MS   = 2000;

// Multi-tap Backlight Toggle Configuration
constexpr uint32_t MULTI_TAP_WINDOW_MS = 1500; // 4 taps within 1.5s
uint8_t  b1TapCount = 0;
uint32_t b1FirstTapAt = 0;
bool     lcdBacklightState = true; // Controlled ONLY by 4-tap sequence

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
  uint8_t pin;
  bool rawPressed;
  bool pressed;
  uint32_t changedAt;
  uint32_t presses;
};

struct LogSnapshot {
  char text[640];
};

struct LogResult {
  bool ok;
  char fileName[13];
  const char *message;
};

Button buttons[] = {
  {BUTTON_1, false, false, 0, 0},
  {BUTTON_2, false, false, 0, 0}
};

bool sharingActive     = true; // Active on boot; controllable via B1 & B2
bool pendingActiveSync = false;
bool wasWifiConnected  = false;
bool lcdFound          = false;
bool mpuReady          = false;
bool mpuSampleValid    = false;

float tiltDegrees  = 0.0f;
float rollXDegrees = 0.0f;
float pitchYDegrees= 0.0f;
float accelXg      = 0.0f;
float accelYg      = 0.0f;
float accelZg      = 0.0f;

double lastKnownLat = 23.718382;
double lastKnownLng = 90.384001;

bool wifiStarted         = false;
uint32_t lastWifiAttemptAt = 0;
bool gpsReceived         = false;
uint32_t lastGpsByteAt   = 0;
uint32_t lastNmeaAt      = 0;
uint32_t lastMpuAt       = 0;
uint32_t lastLcdAt       = 0;
uint32_t lastFirebaseTelemetryAt = 0;
uint32_t lastLedPatternAt = 0;
uint32_t pageSince       = 0;
Page page                = LCD_INFO;

// Buzzer Engine
bool buzzerOn          = false;
uint32_t beepsPending  = 0;
uint32_t buzzerEdgeAt  = 0;

// FreeRTOS SD Logging
QueueHandle_t logQueue       = nullptr;
QueueHandle_t logResultQueue = nullptr;
uint32_t lastLogAt           = 0;
uint32_t logMessageAt        = 0;
bool showLogMessage          = false;
LogResult lastLogResult      = {};

// ======================================================
// PIN UNIQUE VALIDATION
// ======================================================
constexpr bool gpioAssignmentsAreUnique() {
  const uint8_t pins[] = {
    GPS_RX, GPS_TX, SDA_PIN, SCL_PIN, BUZZER_PIN, BUTTON_1, BUTTON_2,
    SD_SCK, SD_MISO, SD_MOSI, SD_CS
  };
  uint64_t used = 0;
  for (uint8_t pin : pins) {
    const uint64_t mask = 1ULL << pin;
    if (used & mask) return false;
    used |= mask;
  }
  for (uint8_t pin : LED_PINS) {
    const uint64_t mask = 1ULL << pin;
    if (used & mask) return false;
    used |= mask;
  }
  return true;
}
static_assert(gpioAssignmentsAreUnique(), "GPIO conflict: assign each signal a separate pin.");

// ======================================================
// LCD CONFIRMATION HELPER (FORWARD DECLARATIONS & ENGINE)
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
  confirmMessageAt = millis();
  showConfirmMessage = true;
  lcdLine(0, confirmTop);
  lcdLine(1, confirmBottom);
}

// ======================================================
// FIREBASE REST API HELPERS
// ======================================================
bool firebasePUT(const String &path, const String &json) {
  if (WiFi.status() != WL_CONNECTED) return false;

  HTTPClient http;
  String url = String(FIREBASE_HOST) + path + ".json";
  http.begin(url);
  http.setTimeout(1500);
  http.addHeader("Content-Type", "application/json");

  int httpCode = http.PUT(json);
  http.end();
  return (httpCode >= 200 && httpCode < 300);
}

void syncActiveStatusToFirebase() {
  // Ensure buzzer is completely silent and pin is LOW while network request is in flight
  digitalWrite(BUZZER_PIN, LOW);
  buzzerOn = false;

  bool ok = false;
  if (WiFi.status() == WL_CONNECTED) {
    String json = sharingActive ? "true" : "false";
    ok = firebasePUT("/tracker/active", json);
  }

  // Confirmation obtained: deliver quick confirmation beeps and LCD text!
  if (sharingActive) {
    beepsPending = 2; // Exactly 2 quick crisp beeps (60ms ON, 60ms GAP)
    lcdConfirmation("RIDE: ACTIVE", ok ? "Cloud Confirmed" : "Local Active");
  } else {
    beepsPending = 3; // Exactly 3 quick crisp beeps (60ms ON, 60ms GAP)
    lcdConfirmation("RIDE: STOPPED", ok ? "Cloud Confirmed" : "Local Standby");
  }
  buzzerEdgeAt = millis();
}

// ======================================================
// I2C & MPU6050 ROUTINES
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
// WI-FI CONNECTION (LOW CURRENT PEAKS)
// ======================================================
void updateWifi(uint32_t now) {
  bool currentConnected = (WiFi.status() == WL_CONNECTED);

  if (!wifiStarted) {
    WiFi.persistent(false);
    WiFi.mode(WIFI_STA);
    WiFi.setTxPower(WIFI_POWER_15dBm); // 15dBm prevents modem current droop
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
  if (gpsHasNmea(now)) return "Waiting for fix";
  if (gpsReceived && now - lastGpsByteAt < GPS_TIMEOUT_MS) return "No valid NMEA";
  return "No UART data";
}

// ======================================================
// 4 STATUS LEDS CONTROLLER
// ======================================================
void updateStatusLeds(uint32_t now) {
  if (now - lastLedPatternAt < 250) return;
  lastLedPatternAt = now;

  static uint8_t activeStep = 0;
  bool hasFix = gpsHasFix(now);
  bool isWifiOk = (WiFi.status() == WL_CONNECTED);

  if (sharingActive) {
    // SHARING IS ACTIVE:
    // RED is OFF.
    digitalWrite(LED_RED, LOW);

    // GREEN & BLUE alternate in active ride-sharing sequence:
    activeStep = (activeStep + 1) % 4;
    digitalWrite(LED_GREEN, (activeStep == 0 || activeStep == 1) ? HIGH : LOW);
    digitalWrite(LED_BLUE,  (hasFix && isWifiOk) ? HIGH : ((activeStep == 2 || activeStep == 3) ? HIGH : LOW));

    // YELLOW stays on when Wi-Fi is ready, blinks on telemetry
    digitalWrite(LED_YELLOW, isWifiOk ? HIGH : LOW);
  } else {
    // SHARING IS STOPPED / STANDBY:
    // RED slow pulse/blink to show standby mode
    static bool redBlink = false;
    redBlink = !redBlink;
    digitalWrite(LED_RED, redBlink ? HIGH : LOW);

    // GREEN, BLUE, YELLOW are OFF when stopped
    digitalWrite(LED_GREEN, LOW);
    digitalWrite(LED_BLUE, LOW);
    digitalWrite(LED_YELLOW, LOW);
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

  // Flash YELLOW LED during transmission
  digitalWrite(LED_YELLOW, HIGH);

  // Compute epoch timestamp if GPS date & time valid (UTC)
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

  // Send complete telemetry payload: coordinates, sats, live X/Y/Z, tilt, and device timestamp
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

  if (showConfirmMessage && now - confirmMessageAt < CONFIRM_MSG_MS) {
    lcdLine(0, confirmTop);
    lcdLine(1, confirmBottom);
    return;
  }
  showConfirmMessage = false;

  if (showLogMessage && now - logMessageAt < SD_MESSAGE_MS) {
    lcdLine(0, lastLogResult.ok ? "SD SAVE OK" : "SD SAVE ERROR");
    lcdLine(1, lastLogResult.ok ? lastLogResult.fileName : lastLogResult.message);
    return;
  }
  showLogMessage = false;
  if (now - pageSince >= PAGE_TIME_MS) {
    page = static_cast<Page>((page + 1) % PAGE_COUNT);
    pageSince = now;
  }

  char top[32] = "";
  char bottom[32] = "";
  switch (page) {
    case LCD_INFO:
      snprintf(top, sizeof(top), "CHALOK TRACKER");
      snprintf(bottom, sizeof(bottom), "Ride:%s BL:%s",
               sharingActive ? "ACTIVE" : "OFF", lcdBacklightState ? "ON" : "OFF");
      break;

    case WIFI_STATUS:
      if (WiFi.status() == WL_CONNECTED) {
        IPAddress ip = WiFi.localIP();
        snprintf(top, sizeof(top), "WiFi CONNECTED");
        snprintf(bottom, sizeof(bottom), "%u.%u.%u.%u", ip[0], ip[1], ip[2], ip[3]);
      } else {
        snprintf(top, sizeof(top), "WiFi CONNECTING");
        snprintf(bottom, sizeof(bottom), "Check ZTE 2.4G");
      }
      break;

    case GPS_STATUS:
      if (gpsHasNmea(now) && gps.satellites.isValid() && gps.satellites.age() < GPS_TIMEOUT_MS) {
        snprintf(top, sizeof(top), "Sats: %lu", static_cast<unsigned long>(gps.satellites.value()));
      } else {
        snprintf(top, sizeof(top), "GPS: no sat data");
      }
      snprintf(bottom, sizeof(bottom), "%s", gpsStatus(now));
      break;

    case GPS_COORDS:
      if (gpsHasFix(now)) {
        snprintf(top, sizeof(top), "Lat %+.5f", gps.location.lat());
        snprintf(bottom, sizeof(bottom), "Lon %+.5f", gps.location.lng());
      } else {
        snprintf(top, sizeof(top), "GPS coordinates");
        snprintf(bottom, sizeof(bottom), "Waiting for fix");
      }
      break;

    case MPU_TILT:
      if (mpuSampleValid) {
        snprintf(top, sizeof(top), "Tilt:%4.1f deg", tiltDegrees);
        snprintf(bottom, sizeof(bottom), "R:%+4.1f P:%+4.1f", rollXDegrees, pitchYDegrees);
      } else {
        snprintf(top, sizeof(top), "MPU6050");
        snprintf(bottom, sizeof(bottom), mpuReady ? "No sample" : "Read error");
      }
      break;

    case MPU_ACCEL_XYZ:
      if (mpuSampleValid) {
        snprintf(top, sizeof(top), "X:%+.2f Y:%+.2f", accelXg, accelYg);
        snprintf(bottom, sizeof(bottom), "Z:%+.2f g-force", accelZg);
      } else {
        snprintf(top, sizeof(top), "MPU Accel X,Y,Z");
        snprintf(bottom, sizeof(bottom), "Waiting sample");
      }
      break;

    case BUTTONS:
      snprintf(top, sizeof(top), "B1:START B2:STOP");
      snprintf(bottom, sizeof(bottom), "4-Tap B1:LCD BL");
      break;

    case OUTPUTS:
      snprintf(top, sizeof(top), "LEDs: %s", sharingActive ? "ACTIVE" : "STANDBY");
      snprintf(bottom, sizeof(bottom), "Buzzer: %s", buzzerOn ? "ON" : "OFF");
      break;

    case PAGE_COUNT:
      break;
  }
  lcdLine(0, top);
  lcdLine(1, bottom);
}

// ======================================================
// BUTTONS & MULTI-TAP 4-PULSE BACKLIGHT TOGGLE
// ======================================================
void readButtons(uint32_t now) {
  // Check if 4-tap window expired without hitting 4
  if (b1TapCount > 0 && (now - b1FirstTapAt > MULTI_TAP_WINDOW_MS)) {
    b1TapCount = 0;
  }

  for (uint8_t i = 0; i < 2; ++i) {
    Button &button = buttons[i];
    bool pressed = (digitalRead(button.pin) == LOW);

    if (pressed != button.rawPressed) {
      button.rawPressed = pressed;
      button.changedAt = now;
    }
    if (pressed == button.pressed || now - button.changedAt < 35) continue;
    button.pressed = pressed;

    if (pressed) {
      ++button.presses;

      if (i == 0) {
        // BUTTON_1 Pressed (GPIO 23)
        // Multi-tap detection for LCD backlight
        if (b1TapCount == 0) b1FirstTapAt = now;
        b1TapCount++;

        if (b1TapCount >= 4) {
          // Exactly 4 rapid pulses detected: TOGGLE LCD BACKLIGHT!
          lcdBacklightState = !lcdBacklightState;
          if (lcdFound) {
            if (lcdBacklightState) lcd.backlight();
            else lcd.noBacklight();
          }
          b1TapCount = 0;
          beepsPending = 1; // 1 single quick chirp on toggle
          buzzerEdgeAt = now;
          lcdConfirmation("LCD BACKLIGHT", lcdBacklightState ? "Turned ON" : "Turned OFF");
        } else if (b1TapCount == 1) {
          // Normal START Sharing action (tap 1)
          if (!sharingActive) {
            sharingActive = true;
            pendingActiveSync = true;
            beepsPending = 0; // DO NOT buzz while request in flight! Wait for confirmation
            lcdConfirmation("START SHARING", "Syncing...");
          }
        }
      } else {
        // BUTTON_2 Pressed (GPIO 32): STOP Sharing
        if (sharingActive) {
          sharingActive = false;
          pendingActiveSync = true;
          beepsPending = 0; // DO NOT buzz while request in flight! Wait for confirmation
          lcdConfirmation("STOP SHARING", "Syncing...");
        }
        b1TapCount = 0;
      }

      showPage(BUTTONS);
    }
  }
}

// ======================================================
// BUZZER ENGINE (CRISP MULTI-BEEPS)
// ======================================================
void updateBuzzer(uint32_t now) {
  if (buzzerOn && now - buzzerEdgeAt >= BEEP_ON_MS) {
    digitalWrite(BUZZER_PIN, LOW);
    buzzerOn = false;
    buzzerEdgeAt = now;
  } else if (!buzzerOn && beepsPending > 0 && now - buzzerEdgeAt >= BEEP_GAP_MS) {
    --beepsPending;
    digitalWrite(BUZZER_PIN, HIGH);
    buzzerOn = true;
    buzzerEdgeAt = now;
  }
}

// ======================================================
// SD CARD BACKGROUND LOGGER (FREERTOS WORKER)
// ======================================================
void formatSnapshot(LogSnapshot &snapshot, uint32_t now) {
  char satellites[16] = "N/A";
  char location[64]   = "N/A";
  char mpu[120]       = "N/A";

  if (gpsHasNmea(now) && gps.satellites.isValid() && gps.satellites.age() < GPS_TIMEOUT_MS) {
    snprintf(satellites, sizeof(satellites), "%lu", static_cast<unsigned long>(gps.satellites.value()));
  }
  if (gpsHasFix(now)) {
    snprintf(location, sizeof(location), "lat=%.6f lon=%.6f", gps.location.lat(), gps.location.lng());
  }
  if (mpuSampleValid) {
    snprintf(mpu, sizeof(mpu), "tilt=%.1f roll=%.1f pitch=%.1f X=%.2fg Y=%.2fg Z=%.2fg",
             tiltDegrees, rollXDegrees, pitchYDegrees, accelXg, accelYg, accelZg);
  }

  snprintf(snapshot.text, sizeof(snapshot.text),
           "CHALOK status | uptime_ms=%lu | SHARING=%s\n"
           "[LCD] 0x27 %s | Backlight=%s\n"
           "[WiFi] %s\n"
           "[GPS] %s | satellites=%s | %s\n"
           "[MPU6050] %s\n"
           "[BUTTONS] B1_Start=%lu | B2_Stop=%lu\n"
           "[LEDS] Mode=%s\n",
           static_cast<unsigned long>(now),
           sharingActive ? "ACTIVE" : "STOPPED",
           lcdFound ? "ACK at startup" : "no ACK",
           lcdBacklightState ? "ON" : "OFF",
           WiFi.status() == WL_CONNECTED ? "connected" : "disconnected",
           gpsStatus(now), satellites, location, mpu,
           static_cast<unsigned long>(buttons[0].presses),
           static_cast<unsigned long>(buttons[1].presses),
           sharingActive ? "ACTIVE_CHASE" : "STANDBY_BLINK");
}

const char *saveSnapshot(const LogSnapshot &snapshot, char *fileName, uint32_t &nextId) {
  char finalPath[14];
  char tempPath[14];
  do {
    unsigned long id = nextId++;
    snprintf(finalPath, sizeof(finalPath), "/%08lX.TXT", id);
    snprintf(tempPath, sizeof(tempPath), "/%08lX.TMP", id);
  } while (SD.exists(finalPath) || SD.exists(tempPath));

  File file = SD.open(tempPath, FILE_WRITE);
  if (!file) return "Open failed";
  size_t length = strlen(snapshot.text);
  bool written = file.write(reinterpret_cast<const uint8_t *>(snapshot.text), length) == length;
  file.close();

  File saved = SD.open(tempPath, FILE_READ);
  char readBack[sizeof(snapshot.text)];
  bool verified = written && saved && saved.size() == length &&
                  saved.read(reinterpret_cast<uint8_t *>(readBack), length) == length &&
                  memcmp(readBack, snapshot.text, length) == 0;
  saved.close();

  if (!verified || !SD.rename(tempPath, finalPath)) {
    SD.remove(tempPath);
    return verified ? "Rename failed" : "Write failed";
  }
  strcpy(fileName, finalPath + 1);
  return nullptr;
}

void logWorker(void *) {
  SPI.begin(SD_SCK, SD_MISO, SD_MOSI, SD_CS);
  bool mounted = false;
  uint32_t nextId = esp_random();
  LogSnapshot snapshot;
  for (;;) {
    if (xQueueReceive(logQueue, &snapshot, portMAX_DELAY) != pdTRUE) continue;
    LogResult result = {};
    if (!mounted) mounted = SD.begin(SD_CS, SPI);
    if (mounted) {
      result.message = saveSnapshot(snapshot, result.fileName, nextId);
      result.ok = (result.message == nullptr);
      if (!result.ok) {
        SD.end();
        mounted = false;
      }
    } else {
      result.message = "Card mount fail";
    }
    xQueueOverwrite(logResultQueue, &result);
  }
}

void showSdResult(const LogResult &result) {
  lastLogResult = result;
  logMessageAt = millis();
  showLogMessage = true;
}

void updateLogging(uint32_t now) {
  LogResult result;
  if (logResultQueue && xQueueReceive(logResultQueue, &result, 0) == pdTRUE) {
    showSdResult(result);
  }
  if (now - lastLogAt < LOG_INTERVAL_MS) return;
  lastLogAt = now - (now - lastLogAt) % LOG_INTERVAL_MS;
  if (!logQueue) {
    showSdResult({false, "", "Logger offline"});
    return;
  }
  LogSnapshot snapshot;
  formatSnapshot(snapshot, now);
  if (xQueueSend(logQueue, &snapshot, 0) != pdTRUE) {
    showSdResult({false, "", "Card busy"});
  }
}

// ======================================================
// ARDUINO SETUP & LOOP
// ======================================================
void setup() {
  Serial.begin(115200);
  delay(50);
  Serial.println("\n[INIT] CHALOK Live GPS Tracker Starting...");

  for (uint8_t pin : LED_PINS) {
    pinMode(pin, OUTPUT);
    digitalWrite(pin, LOW);
  }
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
    lcd.print("CHALOK TRACKER");
    lcd.setCursor(0, 1);
    lcd.print("Starting...");
  }

  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setTxPower(WIFI_POWER_15dBm); // 15dBm prevents modem current droop / brownouts
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  wifiStarted = true;
  lastWifiAttemptAt = millis();

  gpsPort.setRxBufferSize(1024);
  gpsPort.begin(9600, SERIAL_8N1, GPS_RX, GPS_TX);

  logQueue = xQueueCreate(1, sizeof(LogSnapshot));
  logResultQueue = xQueueCreate(1, sizeof(LogResult));
  if (!logQueue || !logResultQueue ||
      xTaskCreate(logWorker, "SD logger", 6144, nullptr, 1, nullptr) != pdPASS) {
    if (logQueue) vQueueDelete(logQueue);
    if (logResultQueue) vQueueDelete(logResultQueue);
    logQueue = nullptr;
    logResultQueue = nullptr;
    showSdResult({false, "", "Logger offline"});
  }

  digitalWrite(LED_GREEN, HIGH);
  showPage(LCD_INFO);
  lastLogAt = pageSince;
  refreshLcd(pageSince);
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
  updateBuzzer(millis());
  updateLogging(now);

  now = millis();
  if (now - lastLcdAt >= 200) {
    lastLcdAt = now;
    refreshLcd(now);
  }
}
