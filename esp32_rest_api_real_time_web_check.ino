#include <TinyGPS++.h>
#include <WiFi.h>
#include <HTTPClient.h>

// ======================================================
// WIFI
// ======================================================

const char* WIFI_SSID = "esp32wifi";
const char* WIFI_PASSWORD = "esp32password";

// ======================================================
// FIREBASE
// ======================================================

const char* FIREBASE_URL =
    "https://track-test-4ddde-default-rtdb.asia-southeast1.firebasedatabase.app";

// ======================================================
// PINS
// ======================================================

#define START_BUTTON 25
#define STOP_BUTTON 26

#define BUZZER_PIN 22

#define RED_LED 19
#define GREEN_LED 18
#define BLUE_LED 2

#define GPS_RX 16
#define GPS_TX 17

// ======================================================
// GPS
// ======================================================

TinyGPSPlus gps;
HardwareSerial GPS(2);

// ======================================================
// SYSTEM
// ======================================================

bool systemActive = false;

unsigned long lastFirebaseUpdate = 0;
unsigned long lastWiFiCheck = 0;

const unsigned long FIREBASE_INTERVAL = 1000;

// ======================================================
// JOURNEY
// ======================================================

// Last point actually stored in journey
double lastJourneyLat = 0.0;
double lastJourneyLng = 0.0;

bool hasJourneyPoint = false;

// Minimum movement before recording another journey point
const double JOURNEY_DISTANCE_METERS = 2.5;

// ======================================================
// SEND TO FIREBASE
// ======================================================

bool firebasePUT(String path, String json)
{
    if (WiFi.status() != WL_CONNECTED)
    {
        return false;
    }

    HTTPClient http;

    String url = String(FIREBASE_URL) + path + ".json";

    http.begin(url);
    http.addHeader("Content-Type", "application/json");

    int httpCode = http.PUT(json);

    if (httpCode > 0)
    {
        Serial.print("Firebase HTTP: ");
        Serial.println(httpCode);

        http.end();

        return httpCode >= 200 && httpCode < 300;
    }

    Serial.print("Firebase error: ");
    Serial.println(http.errorToString(httpCode));

    http.end();

    return false;
}

// ======================================================
// UPDATE ACTIVE STATUS
// ======================================================

void updateActiveStatus(bool active)
{
    String json = active ? "true" : "false";

    if (firebasePUT("/tracker/active", json))
    {
        Serial.print("Firebase active = ");
        Serial.println(active ? "true" : "false");
    }
}

// ======================================================
// SEND CURRENT LOCATION
// ======================================================

void sendCurrentLocation()
{
    if (!gps.location.isValid())
    {
        return;
    }

    double latitude = gps.location.lat();
    double longitude = gps.location.lng();

    double speedKmh = 0.0;

    if (gps.speed.isValid())
    {
        speedKmh = gps.speed.kmph();
    }

    unsigned long satellites = 0;

    if (gps.satellites.isValid())
    {
        satellites = gps.satellites.value();
    }

    double hdop = 0.0;

    if (gps.hdop.isValid())
    {
        hdop = gps.hdop.hdop();
    }

    String json = "{";

    json += "\"lat\":";
    json += String(latitude, 6);

    json += ",\"lng\":";
    json += String(longitude, 6);

    json += ",\"speedKmh\":";
    json += String(speedKmh, 2);

    json += ",\"satellites\":";
    json += String(satellites);

    json += ",\"hdop\":";
    json += String(hdop, 2);

    json += ",\"timestamp\":";
    json += String(millis());

    json += "}";

    Serial.println();
    Serial.println("Sending current location...");

    if (firebasePUT("/tracker/current", json))
    {
        Serial.println("Current location sent.");
    }
}

// ======================================================
// HAVERSINE DISTANCE
// ======================================================

double distanceMeters(
    double lat1,
    double lon1,
    double lat2,
    double lon2)
{
    const double EARTH_RADIUS = 6371000.0;

    double dLat = radians(lat2 - lat1);
    double dLon = radians(lon2 - lon1);

    double a =
        sin(dLat / 2) * sin(dLat / 2) +
        cos(radians(lat1)) *
        cos(radians(lat2)) *
        sin(dLon / 2) *
        sin(dLon / 2);

    double c = 2.0 * atan2(sqrt(a), sqrt(1.0 - a));

    return EARTH_RADIUS * c;
}

// ======================================================
// ADD JOURNEY POINT
// ======================================================

void recordJourneyPoint()
{
    if (!gps.location.isValid())
    {
        return;
    }

    double latitude = gps.location.lat();
    double longitude = gps.location.lng();

    // First journey point
    if (!hasJourneyPoint)
    {
        lastJourneyLat = latitude;
        lastJourneyLng = longitude;

        hasJourneyPoint = true;

        Serial.println("Saving first journey point.");

        String json = "{";

        json += "\"lat\":";
        json += String(latitude, 6);

        json += ",\"lng\":";
        json += String(longitude, 6);

        json += ",\"speedKmh\":";
        json += String(gps.speed.isValid() ? gps.speed.kmph() : 0.0, 2);

        json += ",\"timestamp\":";
        json += String(millis());

        json += "}";

        String path = "/tracker/journey/point_" + String(millis());

        firebasePUT(path, json);

        return;
    }

    // Calculate movement
    double distance = distanceMeters(
        lastJourneyLat,
        lastJourneyLng,
        latitude,
        longitude
    );

    Serial.print("Movement since last journey point: ");
    Serial.print(distance, 2);
    Serial.println(" m");

    // Only save after 2.5 meters
    if (distance >= JOURNEY_DISTANCE_METERS)
    {
        lastJourneyLat = latitude;
        lastJourneyLng = longitude;

        String json = "{";

        json += "\"lat\":";
        json += String(latitude, 6);

        json += ",\"lng\":";
        json += String(longitude, 6);

        json += ",\"speedKmh\":";
        json += String(gps.speed.isValid() ? gps.speed.kmph() : 0.0, 2);

        json += ",\"timestamp\":";
        json += String(millis());

        json += "}";

        String path = "/tracker/journey/point_" + String(millis());

        Serial.println("Movement threshold reached.");
        Serial.println("Saving journey point...");

        if (firebasePUT(path, json))
        {
            Serial.println("Journey point saved.");
        }
    }
}

// ======================================================
// CONNECT WIFI
// ======================================================

void connectWiFi()
{
    Serial.println();
    Serial.println("==============================");
    Serial.println("CONNECTING TO PHONE HOTSPOT");
    Serial.println("==============================");

    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

    int attempts = 0;

    while (WiFi.status() != WL_CONNECTED && attempts < 30)
    {
        delay(500);

        Serial.print(".");

        attempts++;
    }

    Serial.println();

    if (WiFi.status() == WL_CONNECTED)
    {
        Serial.println("WiFi CONNECTED");

        Serial.print("IP Address: ");
        Serial.println(WiFi.localIP());

        digitalWrite(GREEN_LED, HIGH);
        digitalWrite(BLUE_LED, LOW);
    }
    else
    {
        Serial.println("WiFi CONNECTION FAILED");

        digitalWrite(GREEN_LED, LOW);
    }
}

// ======================================================
// START SYSTEM
// ======================================================

void startSystem()
{
    if (systemActive)
    {
        return;
    }

    systemActive = true;

    hasJourneyPoint = false;

    digitalWrite(RED_LED, LOW);
    digitalWrite(GREEN_LED, LOW);
    digitalWrite(BLUE_LED, LOW);

    Serial.println();
    Serial.println("==============================");
    Serial.println("TRACKING STARTED");
    Serial.println("==============================");

    connectWiFi();

    if (WiFi.status() == WL_CONNECTED)
    {
        updateActiveStatus(true);
    }
}

// ======================================================
// STOP SYSTEM
// ======================================================

void stopSystem()
{
    if (!systemActive)
    {
        return;
    }

    systemActive = false;

    digitalWrite(GREEN_LED, LOW);
    digitalWrite(BLUE_LED, LOW);

    noTone(BUZZER_PIN);

    if (WiFi.status() == WL_CONNECTED)
    {
        updateActiveStatus(false);
    }

    Serial.println();
    Serial.println("==============================");
    Serial.println("TRACKING STOPPED");
    Serial.println("==============================");
}

// ======================================================
// SETUP
// ======================================================

void setup()
{
    Serial.begin(115200);

    GPS.begin(
        9600,
        SERIAL_8N1,
        GPS_RX,
        GPS_TX
    );

    pinMode(START_BUTTON, INPUT_PULLUP);
    pinMode(STOP_BUTTON, INPUT_PULLUP);

    pinMode(BUZZER_PIN, OUTPUT);

    pinMode(RED_LED, OUTPUT);
    pinMode(GREEN_LED, OUTPUT);
    pinMode(BLUE_LED, OUTPUT);

    digitalWrite(BUZZER_PIN, LOW);

    // Initially stopped
    digitalWrite(RED_LED, HIGH);
    digitalWrite(GREEN_LED, LOW);
    digitalWrite(BLUE_LED, LOW);

    Serial.println();
    Serial.println("==============================");
    Serial.println("ESP32 FIREBASE GPS TRACKER");
    Serial.println("==============================");
    Serial.println("D25 = START");
    Serial.println("D26 = STOP");
    Serial.println("==============================");
}

// ======================================================
// LOOP
// ======================================================

void loop()
{
    // ----------------------------------------------
    // ALWAYS READ GPS
    // ----------------------------------------------

    while (GPS.available())
    {
        gps.encode(GPS.read());
    }

    // ----------------------------------------------
    // START BUTTON
    // ----------------------------------------------

    if (digitalRead(START_BUTTON) == LOW)
    {
        delay(50);

        if (digitalRead(START_BUTTON) == LOW)
        {
            if (!systemActive)
            {
                startSystem();
            }

            while (digitalRead(START_BUTTON) == LOW)
            {
                delay(10);
            }
        }
    }

    // ----------------------------------------------
    // STOP BUTTON
    // ----------------------------------------------

    if (digitalRead(STOP_BUTTON) == LOW)
    {
        delay(50);

        if (digitalRead(STOP_BUTTON) == LOW)
        {
            if (systemActive)
            {
                stopSystem();
            }

            while (digitalRead(STOP_BUTTON) == LOW)
            {
                delay(10);
            }
        }
    }

    // ----------------------------------------------
    // STOPPED
    // ----------------------------------------------

    if (!systemActive)
    {
        return;
    }

    // ----------------------------------------------
    // WIFI
    // ----------------------------------------------

    if (WiFi.status() != WL_CONNECTED)
    {
        digitalWrite(GREEN_LED, LOW);

        if (millis() - lastWiFiCheck >= 5000)
        {
            lastWiFiCheck = millis();

            Serial.println("WiFi disconnected. Reconnecting...");

            WiFi.disconnect();
            WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
        }

        return;
    }

    digitalWrite(GREEN_LED, HIGH);

    // ----------------------------------------------
    // FIREBASE UPDATE
    // ----------------------------------------------

    if (millis() - lastFirebaseUpdate >= FIREBASE_INTERVAL)
    {
        lastFirebaseUpdate = millis();

        if (gps.location.isValid())
        {
            sendCurrentLocation();

            recordJourneyPoint();

            Serial.println();
            Serial.print("Latitude : ");
            Serial.println(gps.location.lat(), 6);

            Serial.print("Longitude: ");
            Serial.println(gps.location.lng(), 6);

            Serial.print("Speed    : ");
            Serial.print(gps.speed.kmph(), 2);
            Serial.println(" km/h");

            Serial.print("Satellites: ");
            Serial.println(gps.satellites.value());
        }
        else
        {
            Serial.println("GPS: waiting for valid location...");
        }
    }
}