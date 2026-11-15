/*
  =============================================================================
  CHALOK LIVE GPS TRACKER - STABLE BATTERY & ANTI-SHUTOFF EDITION
  =============================================================================
  Hardware Target:
    - Board: ESP32 Dev Module (Classic 30/38-pin with GPIO16/17 available)
    - Power Source: 2x 2600mAh 3.7V 18650 cells in series (~7.4V nominal)
    - Network: GP ZTE F30 Pro 4G Pocket Wi-Fi Hotspot (2.4 GHz)
    - GPS: U-blox NEO-M8N (Autonomous Multi-GNSS at 9600 baud)
    - IMU: MPU6050 6-Axis Gyro/Accelerometer (I2C address 0x68)
    - Display: 16x2 I2C LCD (address 0x27)

  Why Did the Device Shut Off Completely When Unplugged From USB?
    1. Battery / Power Bank Auto-Shutoff (Low-Current Cutoff):
       Most 18650 battery boards, step-down converters, and power bank circuits
       have an automatic sleep feature: if the load draws less than ~45-50mA,
       the circuit assumes "nothing is connected" and cuts power completely!
       The previous test code kept the LCD backlight ON (~45mA) and ran at 240MHz (~80mA)
       totaling ~150mA, which kept the battery awake.
       When we turned off the backlight and dropped to 80MHz, current fell to ~28mA,
       causing the battery circuit to enter auto-sleep!
    2. Upload Error / Flash Corruption:
       If an upload error occurred in Arduino IDE, the flash memory was left
       incomplete or corrupted. When unplugged from USB, the ESP32 bootloader
       cannot start the application and halts.
    3. Unsafe Register Writes:
       Writing directly to raw RTC brownout registers caused boot panics on ESP32
       core v3.x when running untethered.

  Fixes in this Version:
    - Safe, standard ESP32 core initialization (no direct register tampering).
    - Full Serial Monitor debugging at 115200 baud for instant diagnostics.
    - Balanced 160MHz CPU frequency (rock-solid stability, low heat, no brownout).
    - Battery Keep-Awake Protection: Configurable keep-awake current so the external
      battery pack never auto-shuts off.
    - Wi-Fi radio stays completely OFF at boot (0mA RF spike).
    - Button 1 (GPIO 23) starts Wi-Fi, syncs /tracker/active = true immediately.
    - Sends GPS telemetry every 5.0 seconds.
    - Button 2 (GPIO 32) stops streaming and sleeps the radio.
  =============================================================================
*/

#include <Arduino.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <TinyGPS++.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <esp_wifi.h>

// ======================================================
// 1. PIN CONFIGURATIONS
// ======================================================
constexpr uint8_t GPS_RX       = 16;  // ESP32 RX2 <- GPS TX
constexpr uint8_t GPS_TX       = 17;  // ESP32 TX2 -> GPS RX
constexpr uint8_t SDA_PIN      = 21;  // I2C Data (Shared by LCD & MPU6050)
constexpr uint8_t SCL_PIN      = 22;  // I2C Clock

// 4 Dedicated Diagnostic Status LEDs
constexpr uint8_t LED_SYS_PWR  = 4;   // LED 1: System Heartbeat & Power State
constexpr uint8_t LED_GPS_FIX  = 5;   // LED 2: GPS Lock & Satellite Fix Status
constexpr uint8_t LED_WIFI     = 18;  // LED 3: Wi-Fi & Firebase Cloud Connection
constexpr uint8_t LED_TX_BUSY  = 19;  // LED 4: 5-Second Cloud Telemetry TX Pulse

constexpr uint8_t BUZZER_PIN   = 25;  // Active Buzzer (Active HIGH)
constexpr uint8_t BUTTON_1     = 23;  // START / GO LIVE (Active LOW with PULLUP)
constexpr uint8_t BUTTON_2     = 32;  // STOP / STANDBY  (Active LOW with PULLUP)

// MicroSD SPI pins (reserved, unasserted)
constexpr uint8_t SD_SCK       = 14;
constexpr uint8_t SD_MISO      = 27;
constexpr uint8_t SD_MOSI      = 26;
constexpr uint8_t SD_CS        = 13;

// ======================================================
// 2. NETWORK & CLOUD SETTINGS
// ======================================================
const char *WIFI_SSID     = "chalok_device1";
const char *WIFI_PASSWORD = "chalokapp";

// Firebase Realtime Database Host
const char *FIREBASE_HOST = "https://track-test-4ddde-default-rtdb.asia-southeast1.firebasedatabase.app";

// 5-Second Telemetry Interval
constexpr uint32_t TELEMETRY_INTERVAL_MS = 5000;

// LCD & Sensor Addresses
constexpr uint8_t LCD_ADDRESS = 0x27;
constexpr uint8_t LCD_COLS    = 16;
constexpr uint8_t LCD_ROWS    = 2;
constexpr uint8_t MPU_ADDRESS = 0x68;

// ======================================================
// 3. POWER & BATTERY KEEP-AWAKE SETTINGS
// ======================================================
// If your external 2S battery pack / step-down board cuts power when current is low,
// keep this set to true. It maintains ~60mA load so the battery circuit stays ON.
// If your battery has NO auto-off circuit and you want absolute minimum power, set false.
constexpr bool BATTERY_KEEP_AWAKE_MODE = true;

// LCD Backlight: When BATTERY_KEEP_AWAKE_MODE is true, backlight is ON (provides
// the 40mA load needed to prevent battery auto-shutoff). Set false to force it off.
constexpr bool LCD_BACKLIGHT_ENABLED = BATTERY_KEEP_AWAKE_MODE ? true : false;

// Minimum distance in meters before recording a journey route point
constexpr double JOURNEY_DISTANCE_METERS = 2.5;

// ======================================================
// 4. SYSTEM STATE MACHINE
// ======================================================
enum SystemState {
  STATE_STANDBY,        // Booted safely, Wi-Fi radio OFF, GPS locking
  STATE_CONNECTING,     // Button 1 clicked, soft-starting Wi-Fi with capped TX
  STATE_ACTIVE_STREAM,  // Connected to Firebase, streaming coordinates every 5s
  STATE_STOPPING        // Button 2 clicked, sending active=false and cutting radio
};

SystemState currentState = STATE_STANDBY;

// Global Objects
LiquidCrystal_I2C lcd(LCD_ADDRESS, LCD_COLS, LCD_ROWS);
HardwareSerial gpsPort(2);
TinyGPSPlus gps;

// Button Debounce Structure
struct ButtonState {
  uint8_t pin;
  bool rawPressed;
  bool pressed;
  uint32_t changedAt;
  uint32_t presses;
};

ButtonState buttons[] = {
  {BUTTON_1, false, false, 0, 0},
  {BUTTON_2, false, false, 0, 0}
};

// Sensor & Coordinate State
bool lcdFound = false;
bool lcdBacklightOn = LCD_BACKLIGHT_ENABLED;
bool mpuReady = false;
bool mpuSampleValid = false;

float tiltDegrees  = 0.0f;
float rollXDegrees = 0.0f;
float pitchYDegrees= 0.0f;
float accelXg      = 0.0f;
float accelYg      = 0.0f;
float accelZg      = 0.0f;

double lastKnownLat      = 23.718382; // Dhaka default fallback
double lastKnownLng      = 90.384001;
double lastJourneyLat    = 0.0;
double lastJourneyLng    = 0.0;
bool hasJourneyPoint     = false;

// Non-blocking Timers
uint32_t lastTelemetryAt  = 0;
uint32_t lastGpsByteAt    = 0;
uint32_t lastNmeaAt       = 0;
uint32_t lastMpuAt        = 0;
uint32_t lastLcdUpdateAt  = 0;
uint32_t lastWifiCheckAt  = 0;

// LED 4 (TX Strobe) Pulse Timer
uint32_t txStrobeEndAt    = 0;

// Buzzer Non-blocking Control
bool buzzerActive       = false;
uint32_t buzzerEndTime  = 0;
uint8_t  beepsPending   = 0;
uint32_t nextBeepAt     = 0;

// ======================================================
// 5. BUZZER & STROBE ROUTINES
// ======================================================
void triggerBuzzerChirp(uint8_t count, uint16_t durationMs = 45) {
  beepsPending = count;
  nextBeepAt = millis();
}

void updateBuzzer(uint32_t now) {
  if (buzzerActive && now >= buzzerEndTime) {
    digitalWrite(BUZZER_PIN, LOW);
    buzzerActive = false;
    nextBeepAt = now + 60; // 60ms gap
  } else if (!buzzerActive && beepsPending > 0 && now >= nextBeepAt) {
    --beepsPending;
    digitalWrite(BUZZER_PIN, HIGH);
    buzzerActive = true;
    buzzerEndTime = now + 45; // 45ms crisp tactile chirp
  }
}

void triggerTxStrobe() {
  digitalWrite(LED_TX_BUSY, HIGH);
  txStrobeEndAt = millis() + 60;
}

// ======================================================
// 6. GPS STATUS HELPERS
// ======================================================
void readGps() {
  while (gpsPort.available()) {
    lastGpsByteAt = millis();
    if (gps.encode(gpsPort.read())) {
      lastNmeaAt = lastGpsByteAt;
    }
  }
}

bool gpsHasNmea(uint32_t now) {
  return (gps.passedChecksum() > 0) && (now - lastNmeaAt < 5000);
}

bool gpsHasFix(uint32_t now) {
  return gpsHasNmea(now) &&
         gps.location.isValid() &&
         (gps.location.age() < 5000);
}

// ======================================================
// 7. DEDICATED 4-LED INDICATOR ENGINE
// ======================================================
void updateLedIndicators(uint32_t now) {
  // ----------------------------------------------------
  // LED 1 (GPIO 4): SYSTEM HEARTBEAT & POWER
  // ----------------------------------------------------
  if (currentState == STATE_STANDBY) {
    if (BATTERY_KEEP_AWAKE_MODE) {
      // Steady ON in keep-awake mode to maintain load
      digitalWrite(LED_SYS_PWR, HIGH);
    } else {
      // 15ms micro-pulse every 2000ms
      uint32_t cycle = now % 2000;
      digitalWrite(LED_SYS_PWR, (cycle < 15) ? HIGH : LOW);
    }
  } else {
    // In Active Stream or Connecting: Solid ON
    digitalWrite(LED_SYS_PWR, HIGH);
  }

  // ----------------------------------------------------
  // LED 2 (GPIO 5): GPS FIX & SATELLITE STATUS
  // ----------------------------------------------------
  if (gpsHasFix(now)) {
    // Valid 3D fix locked: Solid ON
    digitalWrite(LED_GPS_FIX, HIGH);
  } else if (gpsHasNmea(now)) {
    // Receiving NMEA, searching for satellites: Slow 1Hz blink
    digitalWrite(LED_GPS_FIX, ((now / 500) % 2 == 0) ? HIGH : LOW);
  } else {
    // No GPS data: OFF
    digitalWrite(LED_GPS_FIX, LOW);
  }

  // ----------------------------------------------------
  // LED 3 (GPIO 18): WI-FI & CLOUD LINK
  // ----------------------------------------------------
  if (WiFi.status() == WL_CONNECTED) {
    // Connected to ZTE hotspot: Solid ON
    digitalWrite(LED_WIFI, HIGH);
  } else if (currentState == STATE_CONNECTING) {
    // Connecting to Wi-Fi: Fast 3Hz blink
    digitalWrite(LED_WIFI, ((now / 160) % 2 == 0) ? HIGH : LOW);
  } else {
    // Standby or Radio OFF: OFF
    digitalWrite(LED_WIFI, LOW);
  }

  // ----------------------------------------------------
  // LED 4 (GPIO 19): DATA TX / CLOUD BURST STROBE
  // ----------------------------------------------------
  if (txStrobeEndAt != 0) {
    if (now >= txStrobeEndAt) {
      digitalWrite(LED_TX_BUSY, LOW);
      txStrobeEndAt = 0;
    } else {
      digitalWrite(LED_TX_BUSY, HIGH);
    }
  }
}

// ======================================================
// 8. HAVERSINE DISTANCE FORMULA
// ======================================================
double distanceMeters(double lat1, double lon1, double lat2, double lon2) {
  constexpr double EARTH_RADIUS = 6371000.0;
  double dLat = radians(lat2 - lat1);
  double dLon = radians(lon2 - lon1);
  double a = sin(dLat / 2.0) * sin(dLat / 2.0) +
             cos(radians(lat1)) * cos(radians(lat2)) *
             sin(dLon / 2.0) * sin(dLon / 2.0);
  double c = 2.0 * atan2(sqrt(a), sqrt(1.0 - a));
  return EARTH_RADIUS * c;
}

// ======================================================
// 9. FAST NON-BLOCKING FIREBASE REST CLIENT
// ======================================================
bool firebasePUT(const String &path, const String &json) {
  if (WiFi.status() != WL_CONNECTED) return false;

  HTTPClient http;
  String url = String(FIREBASE_HOST) + path + ".json";
  http.begin(url);
  http.setTimeout(2000); // 2-second timeout prevents loop stall
  http.addHeader("Content-Type", "application/json");

  int httpCode = http.PUT(json);
  http.end();
  Serial.printf("[FIREBASE PUT] %s -> code %d\n", path.c_str(), httpCode);
  return (httpCode >= 200 && httpCode < 300);
}

bool firebasePOST(const String &path, const String &json) {
  if (WiFi.status() != WL_CONNECTED) return false;

  HTTPClient http;
  String url = String(FIREBASE_HOST) + path + ".json";
  http.begin(url);
  http.setTimeout(2000);
  http.addHeader("Content-Type", "application/json");

  int httpCode = http.POST(json);
  http.end();
  Serial.printf("[FIREBASE POST] %s -> code %d\n", path.c_str(), httpCode);
  return (httpCode >= 200 && httpCode < 300);
}

void setCloudActiveStatus(bool active) {
  triggerTxStrobe();
  firebasePUT("/tracker/active", active ? "true" : "false");
}

// ======================================================
// 10. I2C & MPU6050 ROUTINES
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
  for (uint8_t i = 0; i < size; ++i) {
    data[i] = Wire.read();
  }
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
    Serial.println("[MPU] MPU6050 initialized successfully.");
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
// 11. TELEMETRY TRANSMITTER (SENDS AFTER EVERY 5 SECONDS)
// ======================================================
void transmitTelemetry(uint32_t now) {
  if (WiFi.status() != WL_CONNECTED) return;
  if (now - lastTelemetryAt < TELEMETRY_INTERVAL_MS) return;
  lastTelemetryAt = now;

  double lat = lastKnownLat;
  double lng = lastKnownLng;
  double speedKmh = 0.0;
  uint32_t satellites = 0;
  double hdop = 99.0;

  if (gps.location.isValid()) {
    lat = gps.location.lat();
    lng = gps.location.lng();
    lastKnownLat = lat;
    lastKnownLng = lng;
  }
  if (gps.speed.isValid()) {
    speedKmh = gps.speed.kmph();
    if (speedKmh < 1.0) speedKmh = 0.0;
  }
  if (gps.satellites.isValid()) {
    satellites = gps.satellites.value();
  }
  if (gps.hdop.isValid()) {
    hdop = gps.hdop.hdop();
  }

  // 1. Build live telemetry payload (compatible with app.js)
  String payload = "{";
  payload += "\"lat\":" + String(lat, 6) + ",";
  payload += "\"lng\":" + String(lng, 6) + ",";
  payload += "\"speedKmh\":" + String(speedKmh, 1) + ",";
  payload += "\"satellites\":" + String(satellites) + ",";
  payload += "\"hdop\":" + String(hdop, 1) + ",";
  payload += "\"tilt\":" + String(tiltDegrees, 1) + ",";
  payload += "\"roll\":" + String(rollXDegrees, 1) + ",";
  payload += "\"pitch\":" + String(pitchYDegrees, 1) + ",";
  payload += "\"timestamp\":" + String(now);
  payload += "}";

  Serial.printf("[TELEMETRY 5s] Lat: %.6f | Lng: %.6f | Sats: %lu\n", lat, lng, static_cast<unsigned long>(satellites));

  // Strobe LED 4 (GPIO 19)
  triggerTxStrobe();

  firebasePUT("/tracker/current", payload);

  // 2. Journey line recording: only if GPS fix is valid and moved >= 2.5m
  if (gpsHasFix(now)) {
    double distMoved = 0.0;
    if (hasJourneyPoint) {
      distMoved = distanceMeters(lastJourneyLat, lastJourneyLng, lat, lng);
    }

    if (!hasJourneyPoint || distMoved >= JOURNEY_DISTANCE_METERS) {
      String ptPayload = "{";
      ptPayload += "\"lat\":" + String(lat, 6) + ",";
      ptPayload += "\"lng\":" + String(lng, 6) + ",";
      ptPayload += "\"speedKmh\":" + String(speedKmh, 1) + ",";
      ptPayload += "\"tilt\":" + String(tiltDegrees, 1) + ",";
      ptPayload += "\"timestamp\":" + String(now);
      ptPayload += "}";

      firebasePOST("/tracker/journey", ptPayload);
      lastJourneyLat = lat;
      lastJourneyLng = lng;
      hasJourneyPoint = true;
    }
  }
}

// ======================================================
// 12. LCD DISPLAY
// ======================================================
void lcdLine(uint8_t row, const char *line) {
  char padded[LCD_COLS + 1];
  snprintf(padded, sizeof(padded), "%-*.*s", LCD_COLS, LCD_COLS, line);
  lcd.setCursor(0, row);
  lcd.print(padded);
}

void updateLcd(uint32_t now) {
  if (!lcdFound) return;
  if (now - lastLcdUpdateAt < 400) return;
  lastLcdUpdateAt = now;

  char top[20] = "";
  char bottom[20] = "";

  switch (currentState) {
    case STATE_STANDBY: {
      snprintf(top, sizeof(top), "CHALOK STANDBY");
      if (gpsHasFix(now)) {
        snprintf(bottom, sizeof(bottom), "GPS:OK | B1:LIVE");
      } else {
        uint32_t sats = gps.satellites.isValid() ? gps.satellites.value() : 0;
        snprintf(bottom, sizeof(bottom), "Sats:%02lu B1:LIVE", static_cast<unsigned long>(sats));
      }
      break;
    }

    case STATE_CONNECTING: {
      snprintf(top, sizeof(top), "CONNECTING WIFI");
      snprintf(bottom, sizeof(bottom), "ZTE Pocket 4G...");
      break;
    }

    case STATE_ACTIVE_STREAM: {
      uint32_t sats = gps.satellites.isValid() ? gps.satellites.value() : 0;
      double spd = gps.speed.isValid() ? gps.speed.kmph() : 0.0;
      snprintf(top, sizeof(top), "LIVE: ACTIVE 5s");
      snprintf(bottom, sizeof(bottom), "S:%02lu %4.1fkm/h", static_cast<unsigned long>(sats), spd);
      break;
    }

    case STATE_STOPPING: {
      snprintf(top, sizeof(top), "STOPPING STREAM");
      snprintf(bottom, sizeof(bottom), "Standby Mode");
      break;
    }
  }

  lcdLine(0, top);
  lcdLine(1, bottom);
}

// ======================================================
// 13. PROCEDURAL WI-FI ACTIVATION & DEACTIVATION
// ======================================================
void startLiveSharingProcedurally() {
  Serial.println("[WIFI] Button 1 clicked -> Soft-starting Wi-Fi...");
  triggerBuzzerChirp(1, 50);
  triggerTxStrobe();
  currentState = STATE_CONNECTING;
  updateLcd(millis());

  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);

  // Cap Wi-Fi TX Power to 13 dBm (~20 mW)
  // Prevents 450mA current spikes while ensuring rock-solid connection to ZTE pocket modem
  WiFi.setTxPower(WIFI_POWER_13dBm);

  // Enable 802.11 Modem Sleep
  esp_wifi_set_ps(WIFI_PS_MIN_MODEM);

  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  lastWifiCheckAt = millis();
}

void stopLiveSharingAndSleepRadio() {
  Serial.println("[WIFI] Button 2 clicked -> Stopping stream & sleeping radio...");
  triggerBuzzerChirp(2, 60);
  triggerTxStrobe();
  currentState = STATE_STOPPING;
  updateLcd(millis());

  if (WiFi.status() == WL_CONNECTED) {
    setCloudActiveStatus(false);
  }

  WiFi.disconnect(true);
  WiFi.mode(WIFI_OFF);

  currentState = STATE_STANDBY;
  updateLcd(millis());
}

// ======================================================
// 14. INSTANT RESPONSIVE BUTTON HANDLERS
// ======================================================
void readButtons(uint32_t now) {
  for (uint8_t i = 0; i < 2; ++i) {
    ButtonState &b = buttons[i];
    bool isDown = (digitalRead(b.pin) == LOW);

    if (isDown != b.rawPressed) {
      b.rawPressed = isDown;
      b.changedAt = now;
    }

    if (isDown == b.pressed || (now - b.changedAt < 35)) continue;
    b.pressed = isDown;

    if (b.pressed) {
      ++b.presses;

      if (i == 0) {
        // BUTTON 1 (GPIO 23): GO LIVE / MAKE AVAILABLE
        if (currentState == STATE_STANDBY) {
          startLiveSharingProcedurally();
        }
      } else {
        // Track rapid clicks on Button 2 for 4-pulse LCD backlight toggle
        static uint32_t btn2PulseWindow = 0;
        static uint8_t btn2PulseCount = 0;

        if (now - btn2PulseWindow < 1400) {
          btn2PulseCount++;
        } else {
          btn2PulseCount = 1;
        }
        btn2PulseWindow = now;

        if (btn2PulseCount >= 4) {
          btn2PulseCount = 0;
          lcdBacklightOn = !lcdBacklightOn;
          if (lcdFound) {
            if (lcdBacklightOn) lcd.backlight();
            else lcd.noBacklight();
          }
          triggerBuzzerChirp(1, 30);
          Serial.printf("[LCD] 4-pulse toggle -> Backlight %s\n", lcdBacklightOn ? "ON" : "OFF");
        } else {
          // BUTTON 2 (GPIO 32): STOP / STANDBY
          if (currentState != STATE_STANDBY) {
            stopLiveSharingAndSleepRadio();
          }
        }
      }
    }
  }
}

// ======================================================
// 15. WI-FI CONNECTION CHECKER (NON-BLOCKING)
// ======================================================
void checkWifiProgress(uint32_t now) {
  if (currentState == STATE_CONNECTING) {
    if (WiFi.status() == WL_CONNECTED) {
      Serial.println("[WIFI] Successfully connected to ZTE hotspot!");
      Serial.printf("[WIFI] IP Address: %s\n", WiFi.localIP().toString().c_str());

      triggerBuzzerChirp(2, 40);
      triggerTxStrobe();

      // Immediately notify Firebase that device is active & online
      setCloudActiveStatus(true);

      currentState = STATE_ACTIVE_STREAM;
      lastTelemetryAt = 0; // Force immediate first transmission
      updateLcd(now);
    } else if (now - lastWifiCheckAt > 15000) {
      lastWifiCheckAt = now;
      Serial.println("[WIFI] Connection timeout, retrying...");
      WiFi.disconnect();
      WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    }
  } else if (currentState == STATE_ACTIVE_STREAM) {
    if (WiFi.status() != WL_CONNECTED && (now - lastWifiCheckAt > 8000)) {
      lastWifiCheckAt = now;
      Serial.println("[WIFI] Connection dropped; auto-reconnecting...");
      WiFi.reconnect();
    }
  }
}

// ======================================================
// 16. ARDUINO SETUP
// ======================================================
void setup() {
  // Step 1: Initialize Serial Monitor at 115200 baud
  Serial.begin(115200);
  delay(100);
  Serial.println("\n==============================================");
  Serial.println("  CHALOK GPS TRACKER - STABLE BATTERY EDITION ");
  Serial.println("==============================================");

  // Set stable CPU frequency (160MHz is ultra-stable, prevents clock jitter and brownout)
  setCpuFrequencyMhz(160);

  // Step 2: Initialize Diagnostic LEDs and Buzzer
  pinMode(LED_SYS_PWR, OUTPUT);
  pinMode(LED_GPS_FIX, OUTPUT);
  pinMode(LED_WIFI, OUTPUT);
  pinMode(LED_TX_BUSY, OUTPUT);

  digitalWrite(LED_SYS_PWR, HIGH); // Power indicator ON
  digitalWrite(LED_GPS_FIX, LOW);
  digitalWrite(LED_WIFI, LOW);
  digitalWrite(LED_TX_BUSY, LOW);

  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);

  pinMode(SD_CS, OUTPUT);
  digitalWrite(SD_CS, HIGH);

  // Step 3: Initialize Pushbuttons with Internal PULLUP
  pinMode(BUTTON_1, INPUT_PULLUP);
  pinMode(BUTTON_2, INPUT_PULLUP);

  delay(100);

  // Step 4: Initialize I2C Bus & LCD
  Wire.begin(SDA_PIN, SCL_PIN, 100000);
  Wire.setTimeOut(40);

  lcdFound = i2cPresent(LCD_ADDRESS);
  Serial.printf("[LCD] I2C 0x%02X: %s\n", LCD_ADDRESS, lcdFound ? "DETECTED" : "NOT FOUND");
  if (lcdFound) {
    lcd.init();
    if (LCD_BACKLIGHT_ENABLED) {
      lcd.backlight();
    } else {
      lcd.noBacklight();
    }
    lcd.clear();
    lcdLine(0, "CHALOK TRACKER");
    lcdLine(1, "STANDBY (READY)");
  }

  // Step 5: Initialize GPS UART on Serial2
  gpsPort.setRxBufferSize(1024);
  gpsPort.begin(9600, SERIAL_8N1, GPS_RX, GPS_TX);
  Serial.printf("[GPS] Serial2 on RX=%d, TX=%d @ 9600 baud\n", GPS_RX, GPS_TX);

  // Step 6: Probe MPU6050
  sampleMpu();

  // Step 7: Radio stays explicitly OFF at boot
  WiFi.mode(WIFI_OFF);
  Serial.println("[WIFI] Radio OFF at boot (no surge spike). Press B1 to Go Live.");

  // Audible boot confirmation: 1 short chirp
  triggerBuzzerChirp(1, 50);

  currentState = STATE_STANDBY;
  updateLcd(millis());
}

// ======================================================
// 17. MAIN LOOP
// ======================================================
void loop() {
  // High-priority GPS sentence ingestion
  readGps();

  uint32_t now = millis();

  // Button debouncing & instant action
  readButtons(now);

  // Wi-Fi connection state handler
  checkWifiProgress(now);

  // Buzzer & 4-LED dedicated indicator engine
  updateBuzzer(now);
  updateLedIndicators(now);

  // Sample MPU6050 every 250ms
  if (now - lastMpuAt >= 250) {
    lastMpuAt = now;
    sampleMpu();
  }

  // If live streaming is active, transmit telemetry every 5 seconds
  if (currentState == STATE_ACTIVE_STREAM) {
    transmitTelemetry(now);
  }

  // Refresh LCD every 400ms
  updateLcd(now);
}
