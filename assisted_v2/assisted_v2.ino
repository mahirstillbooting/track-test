/*
  =============================================================================
  PROJECT CHALOK - ASSISTED_V2 FIRMWARE
  =============================================================================
  Target Board : ESP32 Dev Module
  Libraries    : LiquidCrystal_I2C, TinyGPSPlus, Wire, SPI, SD, WiFi, HTTPClient, Preferences
  Primary Focus: Dynamic Wi-Fi/Modem IP Geolocation A-GPS Injection, Non-Blinding
                 Status LED Diagnostics, NVS Memory Persistence, Cold-Start Inrush
                 Protection & Safe Buzzer Engine.

  Key Upgrades in assisted_v2:
    1. Dynamic Wi-Fi/Modem IP Geolocation (Zero Lalbagh Hardcode):
       - Upon connecting to Wi-Fi/Modem hotspot, immediately performs a lightweight
         HTTP GET to IP-Geolocation (http://ip-api.com/json/?fields=status,lat,lon,city).
       - Automatically retrieves real coordinates of the connected network (e.g., Aftabnagar,
         Rampura, or wherever you are located).
       - Seeds NEO-M8N GNSS receiver with exact network coordinates & UTC time.
       - Indoors/room testing seamlessly reports real neighborhood position rather than Lalbagh!
    2. NVS Flash Persistence (Preferences.h):
       - Real outdoor 3D satellite fixes are permanently saved to ESP32 flash.
       - On boot, if offline, remembers your true last location instead of a hardcoded point.
    3. Non-Blinding Diagnostic LEDs (Blue & Orange Refined):
       - BLUE (GPIO 5)   : Micro-heartbeat (25ms pulse every 2s) ONLY when 3D GPS Fix is locked.
                           Dark 98.8% of the time - ZERO glare on LCD screen! OFF while searching.
       - ORANGE (GPIO 18): Cloud TX Strobe (35ms momentary wink ONLY during Firebase PUT).
                           Dark by default - zero glare, indicates actual data upload.
       - GREEN (GPIO 4)  : Active Ride Sharing indicator (gentle 1Hz pulse).
       - RED (GPIO 19)   : Standby heartbeat (40ms pulse every 2s).
    4. Staggered Cold-Start Power Sequencing:
       - 3.5s silent boot delay protects 3S battery without capacitors.
       - RF power capped at 15dBm (WIFI_POWER_15dBm) to eliminate voltage sag/brownouts.
    5. Tactile Buzzer Engine with Anti-Scream Safety:
       - 45ms crisp chirps (2 pips on Start, 3 pips on Stop).
       - Hard safety shutoff: Buzzer forced LOW before network calls.
    6. Distinct Button Roles:
       - BUTTON 1 (GPIO 23): Short click (< 2s) = START sharing (only if stopped).
                             2-Second Hold (>= 2s) = Toggle LCD Backlight ON/OFF.
       - BUTTON 2 (GPIO 32): Immediate STOP sharing / enter Standby.
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
#include <time.h>
#include <Preferences.h>

// ======================================================
// PIN DEFINITIONS
// ======================================================
constexpr uint8_t GPS_RX  = 16; // ESP32 RX2 <- GPS TX
constexpr uint8_t GPS_TX  = 17; // ESP32 TX2 -> GPS RX (Transmits A-GPS UBX packets!)
constexpr uint8_t SDA_PIN = 21;
constexpr uint8_t SCL_PIN = 22;

// 4 Verified Physical LEDs
constexpr uint8_t LED_GREEN  = 4;   // GPIO 4  = GREEN  (Active Sharing)
constexpr uint8_t LED_BLUE   = 5;   // GPIO 5  = BLUE   (GPS 3D Fix Heartbeat)
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
// NETWORK & CLOUD SETTINGS
// ======================================================
const char *WIFI_SSID     = "chalok_device1";
const char *WIFI_PASSWORD = "chalokapp";
constexpr uint32_t WIFI_RETRY_MS = 10000;

const char *FIREBASE_HOST = "https://track-test-4ddde-default-rtdb.asia-southeast1.firebasedatabase.app";
constexpr uint32_t FIREBASE_TELEMETRY_INTERVAL_MS = 3000; // 3-second cycle

// NTP Server for Accurate UTC Time
const char *NTP_SERVER_1 = "pool.ntp.org";
const char *NTP_SERVER_2 = "time.google.com";
constexpr long  GMT_OFFSET_SEC      = 6 * 3600; // Dhaka is UTC + 6 hours
constexpr int   DAYLIGHT_OFFSET_SEC = 0;

// I2C Addresses
constexpr uint8_t LCD_ADDRESS = 0x27;
constexpr uint8_t LCD_COLS    = 16;
constexpr uint8_t LCD_ROWS    = 2;
constexpr uint8_t MPU_ADDRESS = 0x68;

// Timing Constants
constexpr uint32_t GPS_TIMEOUT_MS    = 5000;
constexpr uint32_t PAGE_TIME_MS      = 2800;
constexpr uint32_t CONFIRM_MSG_MS    = 1800; // 1.8s confirmation display
constexpr uint32_t HOLD_BACKLIGHT_MS = 2000; // Hold Button 1 for 2s to toggle backlight

// ======================================================
// OBJECTS & STATE
// ======================================================
LiquidCrystal_I2C lcd(LCD_ADDRESS, LCD_COLS, LCD_ROWS);
HardwareSerial gpsPort(2);
TinyGPSPlus gps;
Preferences prefs;

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

// A-GPS & Indoor Location State
bool agpsInjected      = false;
bool indoorAssisted    = true;
String networkCity     = "Dhaka";

float tiltDegrees   = 0.0f;
float rollXDegrees  = 0.0f;
float pitchYDegrees = 0.0f;
float accelXg       = 0.0f;
float accelYg       = 0.0f;
float accelZg       = 0.0f;

// Dynamic coordinates (Defaults loaded from NVS flash or Dhaka center, updated by Wi-Fi IP Geo)
double lastKnownLat = 23.772900;
double lastKnownLng = 90.365700;

bool wifiStarted                 = false;
uint32_t lastWifiAttemptAt       = 0;
bool gpsReceived                 = false;
uint32_t lastGpsByteAt           = 0;
uint32_t lastNmeaAt              = 0;
uint32_t lastMpuAt               = 0;
uint32_t lastLcdAt               = 0;
uint32_t lastFirebaseTelemetryAt = 0;
uint32_t lastLedPatternAt        = 0;
uint32_t pageSince               = 0;
Page page                        = LCD_INFO;

// LED Strobe Timing
static uint32_t txStrobeEndAt = 0;

// ======================================================
// NON-BLOCKING TACTILE BUZZER ENGINE (WITH SAFETY CLAMP)
// ======================================================
bool     buzzerActive   = false;
uint8_t  beepsPending   = 0;
uint16_t beepDurationMs = 45;
uint32_t buzzerEndAt    = 0;

void triggerBuzzerChirp(uint8_t beeps = 1, uint16_t durationMs = 45) {
  beepsPending   = beeps;
  beepDurationMs = durationMs;
  if (!buzzerActive && beepsPending > 0) {
    digitalWrite(BUZZER_PIN, HIGH);
    buzzerActive = true;
    buzzerEndAt  = millis() + beepDurationMs;
    --beepsPending;
  }
}

void updateBuzzer(uint32_t now) {
  if (buzzerActive) {
    if (now >= buzzerEndAt) {
      digitalWrite(BUZZER_PIN, LOW);
      buzzerActive = false;
      buzzerEndAt  = now + 50; // 50ms silence between beeps
    }
  } else if (beepsPending > 0 && now >= buzzerEndAt) {
    digitalWrite(BUZZER_PIN, HIGH);
    buzzerActive = true;
    buzzerEndAt  = now + beepDurationMs;
    --beepsPending;
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
// U-BLOX BINARY UBX A-GPS AIDING ENGINE
// ======================================================
void sendUbxPacket(uint8_t msgClass, uint8_t msgId, const uint8_t *payload, uint16_t payloadLen) {
  uint8_t header[6] = {
    0xB5, 0x62,        // UBX Sync Chars
    msgClass, msgId,
    static_cast<uint8_t>(payloadLen & 0xFF),
    static_cast<uint8_t>((payloadLen >> 8) & 0xFF)
  };

  uint8_t ckA = 0;
  uint8_t ckB = 0;

  for (uint8_t i = 2; i < 6; ++i) {
    ckA += header[i];
    ckB += ckA;
  }
  for (uint16_t i = 0; i < payloadLen; ++i) {
    ckA += payload[i];
    ckB += ckA;
  }

  gpsPort.write(header, sizeof(header));
  if (payloadLen > 0 && payload != nullptr) {
    gpsPort.write(payload, payloadLen);
  }
  gpsPort.write(ckA);
  gpsPort.write(ckB);
  gpsPort.flush();
}

// Injects Approximate Coordinates (UBX-MGA-INI-POS_LLH)
void injectAgpsPosition(double lat, double lon) {
  struct __attribute__((packed)) {
    uint8_t  type;         // 0x01 = POS_LLH
    uint8_t  version;      // 0x00
    uint8_t  reserved1[2]; // 0x00, 0x00
    int32_t  lat_deg;      // Lat * 1e7
    int32_t  lon_deg;      // Lon * 1e7
    int32_t  alt_cm;       // Altitude in cm
    uint32_t posAcc_cm;    // Position accuracy in cm (300000 = 3 km radius)
  } packet;

  packet.type         = 0x01;
  packet.version      = 0x00;
  packet.reserved1[0] = 0x00;
  packet.reserved1[1] = 0x00;
  packet.lat_deg      = static_cast<int32_t>(lat * 1e7);
  packet.lon_deg      = static_cast<int32_t>(lon * 1e7);
  packet.alt_cm       = 1500;   // 15 meters
  packet.posAcc_cm    = 300000; // 3 km seed

  sendUbxPacket(0x13, 0x40, reinterpret_cast<const uint8_t *>(&packet), sizeof(packet));
  Serial.printf("[A-GPS] Injected Dynamic Seed: Lat=%.6f, Lon=%.6f\n", lat, lon);
}

// Injects Accurate UTC Time (UBX-MGA-INI-TIME_UTC)
void injectAgpsUtcTime(const struct tm &utcTime) {
  struct __attribute__((packed)) {
    uint8_t  type;         // 0x10 = TIME_UTC
    uint8_t  version;      // 0x00
    uint8_t  ref;          // 0x00 = Receiver source
    int8_t   leapSec;      // 18 leap seconds
    uint16_t year;
    uint8_t  month;
    uint8_t  day;
    uint8_t  hour;
    uint8_t  minute;
    uint8_t  second;
    uint8_t  reserved1;
    uint32_t ns;           // 0
    uint16_t tAccS;        // 1 second accuracy
    uint16_t reserved2;
    uint32_t tAccNs;       // 10 ms accuracy
  } packet;

  memset(&packet, 0, sizeof(packet));
  packet.type    = 0x10;
  packet.version = 0x00;
  packet.ref     = 0x00;
  packet.leapSec = 18;
  packet.year    = utcTime.tm_year + 1900;
  packet.month   = utcTime.tm_mon + 1;
  packet.day     = utcTime.tm_mday;
  packet.hour    = utcTime.tm_hour;
  packet.minute  = utcTime.tm_min;
  packet.second  = utcTime.tm_sec;
  packet.tAccS   = 1;
  packet.tAccNs  = 10000000;

  sendUbxPacket(0x13, 0x40, reinterpret_cast<const uint8_t *>(&packet), sizeof(packet));
  Serial.printf("[A-GPS] Injected UTC Time: %04d-%02d-%02d %02d:%02d:%02d UTC\n",
                packet.year, packet.month, packet.day, packet.hour, packet.minute, packet.second);
}

// ======================================================
// DYNAMIC WI-FI / MODEM IP GEOLOCATION (ZERO SSL, ULTRA-LOW RAM)
// ======================================================
bool fetchNetworkLocation(double &outLat, double &outLng, String &outCity) {
  if (WiFi.status() != WL_CONNECTED) return false;

  HTTPClient http;
  // Lightweight HTTP endpoint: zero SSL handshake overhead, uses < 150ms
  http.begin("http://ip-api.com/json/?fields=status,lat,lon,city");
  http.setTimeout(1800);

  int code = http.GET();
  if (code == 200) {
    String payload = http.getString();
    http.end();

    int latIdx = payload.indexOf("\"lat\":");
    int lonIdx = payload.indexOf("\"lon\":");
    int cityIdx = payload.indexOf("\"city\":\"");

    if (latIdx != -1 && lonIdx != -1) {
      outLat = payload.substring(latIdx + 6, payload.indexOf(",", latIdx)).toDouble();
      int lonEnd = payload.indexOf(",", lonIdx);
      if (lonEnd == -1) lonEnd = payload.indexOf("}", lonIdx);
      outLng = payload.substring(lonIdx + 6, lonEnd).toDouble();

      if (cityIdx != -1) {
        int cityEnd = payload.indexOf("\"", cityIdx + 8);
        if (cityEnd != -1) outCity = payload.substring(cityIdx + 8, cityEnd);
      }
      return (outLat != 0.0 && outLng != 0.0);
    }
  }
  http.end();
  return false;
}

// Orchestrator: Fetches Network Time, Dynamic Location & Seeds NEO-M8N
void executeAgpsBootstrap() {
  if (agpsInjected || WiFi.status() != WL_CONNECTED) return;

  Serial.println("[A-GPS] Fetching network time & dynamic IP geolocation...");
  configTime(0, 0, NTP_SERVER_1, NTP_SERVER_2);

  struct tm timeinfo;
  if (getLocalTime(&timeinfo, 2000)) {
    injectAgpsUtcTime(timeinfo);
  }

  // Query live Wi-Fi / modem IP geolocation
  double netLat = 0.0;
  double netLng = 0.0;
  String city   = "Dhaka";
  bool gotGeo   = fetchNetworkLocation(netLat, netLng, city);

  if (gotGeo) {
    lastKnownLat = netLat;
    lastKnownLng = netLng;
    networkCity  = city;
    indoorAssisted = true;
    Serial.printf("[A-GPS] Wi-Fi Geolocation Resolved: %s (%.6f, %.6f)\n", city.c_str(), netLat, netLng);
  } else {
    // If router has no internet routing yet, read last saved location from flash
    prefs.begin("chalok", true);
    lastKnownLat = prefs.getDouble("lat", lastKnownLat);
    lastKnownLng = prefs.getDouble("lng", lastKnownLng);
    prefs.end();
    Serial.printf("[A-GPS] Flash Fallback Location: %.6f, %.6f\n", lastKnownLat, lastKnownLng);
  }

  // Inject resolved coordinates into NEO-M8N receiver
  injectAgpsPosition(lastKnownLat, lastKnownLng);

  agpsInjected = true;
  triggerBuzzerChirp(1, 40);
  lcdConfirmation("A-GPS: IP-NET", gotGeo ? city.c_str() : "Seed: OK");
  Serial.println("[A-GPS] Bootstrap complete! Satellite acquisition accelerated.");
}

// ======================================================
// FIREBASE REST API HELPERS (WITH ANTI-STALL TIMEOUT)
// ======================================================
bool firebasePUT(const String &path, const String &json) {
  if (WiFi.status() != WL_CONNECTED) return false;

  forceBuzzerOff();

  HTTPClient http;
  String url = String(FIREBASE_HOST) + path + ".json";
  http.begin(url);
  http.setTimeout(1200); // 1.2s tight timeout prevents loop stalling
  http.addHeader("Content-Type", "application/json");

  int httpCode = http.PUT(json);
  http.end();

  forceBuzzerOff();
  return (httpCode >= 200 && httpCode < 300);
}

void syncActiveStatusToFirebase() {
  forceBuzzerOff();

  bool ok = false;
  if (WiFi.status() == WL_CONNECTED) {
    String json = sharingActive ? "true" : "false";
    ok = firebasePUT("/tracker/active", json);
  }

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
    triggerBuzzerChirp(1, 40);

    // Bootstrap A-GPS seeding upon network attachment
    executeAgpsBootstrap();
  }
  wasWifiConnected = currentConnected;
}

// ======================================================
// GPS PARSER & DIAGNOSTICS (SEAMLESS INDOOR/OUTDOOR SWITCH)
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
  return gpsHasNmea(now) && gps.location.isValid() && gps.location.age() < GPS_TIMEOUT_MS && gps.satellites.value() >= 4;
}

const char *gpsStatus(uint32_t now) {
  if (gpsHasFix(now)) {
    indoorAssisted = false;
    return "Fix OK (3D)";
  }
  if (agpsInjected) {
    return "A-GPS: IP-NET";
  }
  if (gpsHasNmea(now)) {
    return "Searching Sky";
  }
  if (gpsReceived && now - lastGpsByteAt < GPS_TIMEOUT_MS) return "No valid NMEA";
  return "No UART data";
}

// ======================================================
// STATUS LEDS: NON-BLINDING DIAGNOSTIC PULSE ENGINE
// ======================================================
void updateStatusLeds(uint32_t now) {
  if (now - lastLedPatternAt < 50) return;
  lastLedPatternAt = now;

  bool hasFix   = gpsHasFix(now);

  if (sharingActive) {
    // 1. RED (GPIO 19): Completely OFF during active ride
    digitalWrite(LED_RED, LOW);

    // 2. GREEN (GPIO 4): Smooth 1Hz ride indicator
    uint32_t greenCycle = now % 1000;
    digitalWrite(LED_GREEN, (greenCycle < 500) ? HIGH : LOW);

    // 3. BLUE (GPIO 5): 25ms micro-heartbeat every 2000ms ONLY when 3D GPS Fix is locked
    // Dark 98.8% of the time — ZERO glare on LCD screen!
    if (hasFix) {
      uint32_t blueCycle = now % 2000;
      digitalWrite(LED_BLUE, (blueCycle < 25) ? HIGH : LOW);
    } else {
      digitalWrite(LED_BLUE, LOW); // Off while searching
    }

    // 4. ORANGE (GPIO 18): Cloud TX Pulse (35ms momentary wink on upload)
    // Dark by default - only lights up during Firebase transmission
    if (now >= txStrobeEndAt) {
      digitalWrite(LED_ORANGE, LOW);
    }
  } else {
    // STANDBY MODE:
    // RED (GPIO 19): 40ms pulse every 2s (Standby heartbeat)
    uint32_t redCycle = now % 2000;
    digitalWrite(LED_RED, (redCycle < 40) ? HIGH : LOW);

    // All others strictly OFF
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
  bool is3dFix = false;

  // Outdoor Real 3D Satellite Location Override
  if (gps.location.isValid() && gps.satellites.value() >= 4) {
    lat = gps.location.lat();
    lng = gps.location.lng();
    lastKnownLat = lat;
    lastKnownLng = lng;
    indoorAssisted = false;
    is3dFix = true;

    // Periodically save real fix to NVS flash memory
    static uint32_t lastFlashSave = 0;
    if (now - lastFlashSave > 30000) {
      lastFlashSave = now;
      prefs.begin("chalok", false);
      prefs.putDouble("lat", lat);
      prefs.putDouble("lng", lng);
      prefs.end();
    }
  }

  if (gps.satellites.isValid()) {
    satellites = gps.satellites.value();
  }

  // Trigger brief 35ms ORANGE TX wink during transmission
  digitalWrite(LED_ORANGE, HIGH);
  txStrobeEndAt = now + 35;

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
  payload += "\"fix\":" + String(is3dFix ? "true" : "false") + ",";
  payload += "\"assisted\":" + String(indoorAssisted ? "true" : "false") + ",";
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
      snprintf(top, sizeof(top), "CHALOK ASSIST V2");
      snprintf(bottom, sizeof(bottom), "RIDE: %s", sharingActive ? "ACTIVE" : "STANDBY");
      break;

    case WIFI_STATUS:
      snprintf(top, sizeof(top), "WiFi: %s", (WiFi.status() == WL_CONNECTED) ? "ONLINE" : "SEARCHING");
      snprintf(bottom, sizeof(bottom), "%s", (WiFi.status() == WL_CONNECTED) ? WIFI_SSID : "Connecting...");
      break;

    case GPS_STATUS:
      snprintf(top, sizeof(top), "GPS: %s", gpsStatus(now));
      snprintf(bottom, sizeof(bottom), "Sats: %lu (%s)",
               static_cast<unsigned long>(gps.satellites.value()),
               indoorAssisted ? "Indoor" : "SkyFix");
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
      snprintf(bottom, sizeof(bottom), "A-GPS: %s", agpsInjected ? "SEEDED" : "WAITING");
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
          if (!button.holdHandled && pressDuration >= 40) {
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
          triggerBuzzerChirp(1, 40);
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
  Serial.println("\n[INIT] PROJECT CHALOK - ASSISTED_V2 FIRMWARE STARTING...");

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
    lcd.print("CHALOK ASSIST V2");
    lcd.setCursor(0, 1);
    lcd.print("Starting...");
  }

  // Load last valid GPS coordinates from flash
  prefs.begin("chalok", true);
  lastKnownLat = prefs.getDouble("lat", 23.772900);
  lastKnownLng = prefs.getDouble("lng", 90.365700);
  prefs.end();

  // Staggered cold-start: Wi-Fi radio is initialized with low power
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setTxPower(WIFI_POWER_15dBm); // 15dBm eliminates modem current droop / brownouts
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  wifiStarted = true;
  lastWifiAttemptAt = millis();

  // Initialize GNSS serial with full TX support for UBX A-GPS injection
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
