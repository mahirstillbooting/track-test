/*
  ESP32 Live GPS Tracker for Firebase Realtime Database
  
  Repository: https://github.com/mahirstillbooting/track-test
  
  Overview:
  This sketch reads live GPS coordinates from a NEO-6M / NEO-7M / NEO-8M GPS module 
  and updates telemetry parameters to Firebase Realtime Database via HTTPS REST API.
  
  Database Schema:
  - tracker/active (boolean)
  - tracker/current (lat, lng, speedKmh, satellites, hdop, timestamp)
  - tracker/journey (list of lat/lng points logged when moving > 2.5m)

  Hardware Wiring (ESP32 DevKit v1 to NEO-6M GPS Module):
  - GPS VCC -> ESP32 3.3V / 5V
  - GPS GND -> ESP32 GND
  - GPS TX  -> ESP32 RX2 (GPIO 16)
  - GPS RX  -> ESP32 TX2 (GPIO 17)
  
  Required Arduino IDE Libraries:
  - TinyGPSPlus by Mikal Hart (Install via Arduino Library Manager)
  - Built-in ESP32 Libraries (WiFi, HTTPClient, WiFiClientSecure, HardwareSerial)
*/

#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <TinyGPS++.h>
#include <HardwareSerial.h>
#include <math.h>

// ================= USER CONFIGURATION =================
const char* WIFI_SSID = "YOUR_WIFI_SSID";         // Replace with your Wi-Fi SSID
const char* WIFI_PASS = "YOUR_WIFI_PASSWORD";     // Replace with your Wi-Fi Password

// Firebase Realtime Database URL
const char* FIREBASE_HOST = "https://track-test-4ddde-default-rtdb.asia-southeast1.firebasedatabase.app";
// ======================================================

// GPS HardwareSerial (UART2: RX2 = GPIO 16, TX2 = GPIO 17)
TinyGPSPlus gps;
HardwareSerial gpsSerial(2);

// Journey logging distance threshold (in meters)
const double JOURNEY_DIST_THRESHOLD = 2.5;

// Global tracking variables
double lastJourneyLat = 0.0;
double lastJourneyLng = 0.0;
bool hasFirstJourneyPoint = false;

// Update timers
unsigned long lastUpdateMs = 0;
const unsigned long UPDATE_INTERVAL_MS = 2000; // Push live coordinates every 2 seconds

// Haversine formula to compute distance between two GPS coordinates in meters
double calculateDistance(double lat1, double lon1, double lat2, double lon2) {
  double R = 6371000.0; // Earth radius in meters
  double dLat = (lat2 - lat1) * M_PI / 180.0;
  double dLon = (lon2 - lon1) * M_PI / 180.0;
  double a = sin(dLat / 2.0) * sin(dLat / 2.0) +
             cos(lat1 * M_PI / 180.0) * cos(lat2 * M_PI / 180.0) *
             sin(dLon / 2.0) * sin(dLon / 2.0);
  double c = 2.0 * atan2(sqrt(a), sqrt(1.0 - a));
  return R * c;
}

// Send HTTPS request to Firebase RTDB REST endpoint
bool sendFirebaseRequest(const String& path, const String& jsonPayload, const String& method = "PATCH") {
  if (WiFi.status() != WL_CONNECTED) return false;

  WiFiClientSecure client;
  client.setInsecure(); // Skip SSL certificate verification for demo simplicity

  HTTPClient http;
  String fullUrl = String(FIREBASE_HOST) + path + ".json";

  if (!http.begin(client, fullUrl)) {
    Serial.println("[Firebase] HTTP begin failed");
    return false;
  }

  http.addHeader("Content-Type", "application/json");

  int httpCode = 0;
  if (method == "PATCH") {
    httpCode = http.PATCH(jsonPayload);
  } else if (method == "PUT") {
    httpCode = http.PUT(jsonPayload);
  } else if (method == "POST") {
    httpCode = http.POST(jsonPayload);
  }

  if (httpCode >= 200 && httpCode < 300) {
    // Success
  } else {
    Serial.printf("[Firebase] Request to %s failed, code: %d\n", path.c_str(), httpCode);
  }

  http.end();
  return (httpCode >= 200 && httpCode < 300);
}

void setup() {
  Serial.begin(115200);
  gpsSerial.begin(9600, SERIAL_8N1, 16, 17);

  Serial.println();
  Serial.println("==========================================");
  Serial.println("   ESP32 Live GPS Tracker Starting...    ");
  Serial.println("==========================================");

  // Connect to Wi-Fi
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("Connecting to Wi-Fi");
  
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  
  Serial.println("\nWi-Fi Connected!");
  Serial.print("IP Address: ");
  Serial.println(WiFi.localIP());

  // Mark tracker as ACTIVE in Firebase
  sendFirebaseRequest("/tracker", "{\"active\":true}", "PATCH");
  Serial.println("[Firebase] Tracker set to ACTIVE");
}

void loop() {
  // Feed GPS serial stream to TinyGPS++
  while (gpsSerial.available() > 0) {
    gps.encode(gpsSerial.read());
  }

  // Periodic Telemetry Update
  if (millis() - lastUpdateMs >= UPDATE_INTERVAL_MS) {
    lastUpdateMs = millis();

    double currentLat = 0.0;
    double currentLng = 0.0;
    double speedKmh = 0.0;
    int satellites = 0;
    double hdop = 99.0;
    bool validFix = false;

    if (gps.location.isValid()) {
      currentLat = gps.location.lat();
      currentLng = gps.location.lng();
      speedKmh = gps.speed.kmph();
      satellites = gps.satellites.value();
      hdop = gps.hdop.hdop();
      validFix = true;
    } else {
      Serial.println("[GPS] Searching for satellite fix...");
    }

    if (validFix) {
      // 1. Update live telemetry under tracker/current
      String currentPayload = "{";
      currentPayload += "\"lat\":" + String(currentLat, 6) + ",";
      currentPayload += "\"lng\":" + String(currentLng, 6) + ",";
      currentPayload += "\"speedKmh\":" + String(speedKmh, 1) + ",";
      currentPayload += "\"satellites\":" + String(satellites) + ",";
      currentPayload += "\"hdop\":" + String(hdop, 1) + ",";
      currentPayload += "\"timestamp\":" + String(millis());
      currentPayload += "}";

      sendFirebaseRequest("/tracker/current", currentPayload, "PUT");
      Serial.printf("[Live Update] Lat: %.6f | Lng: %.6f | Speed: %.1f km/h | Sats: %d\n", 
                    currentLat, currentLng, speedKmh, satellites);

      // 2. Check distance moved for journey logging
      double distMoved = 0.0;
      if (hasFirstJourneyPoint) {
        distMoved = calculateDistance(lastJourneyLat, lastJourneyLng, currentLat, currentLng);
      }

      // Log point if moved >= 2.5m or if it's the initial point
      if (!hasFirstJourneyPoint || distMoved >= JOURNEY_DIST_THRESHOLD) {
        String journeyPointPayload = "{";
        journeyPointPayload += "\"lat\":" + String(currentLat, 6) + ",";
        journeyPointPayload += "\"lng\":" + String(currentLng, 6) + ",";
        journeyPointPayload += "\"timestamp\":" + String(millis());
        journeyPointPayload += "}";

        // Append point to tracker/journey
        sendFirebaseRequest("/tracker/journey", journeyPointPayload, "POST");

        lastJourneyLat = currentLat;
        lastJourneyLng = currentLng;
        hasFirstJourneyPoint = true;

        Serial.printf("[Journey Log] New point recorded! Distance moved: %.2f meters\n", distMoved);
      }
    }
  }
}
