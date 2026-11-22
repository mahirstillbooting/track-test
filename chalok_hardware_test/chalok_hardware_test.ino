/*
  =============================================================================
  PROJECT CHALOK - HARDWARE DIAGNOSTIC & MPU-6050 MOTION TESTER
  =============================================================================
  Purpose:
    1. Sequentially tests the 4 diagnostic LED pins (GPIO 4, 5, 18, 19).
       - Each LED stays ON for exactly 2 seconds (2000 ms) while others are OFF.
       - LCD shows exactly which GPIO pin is currently glowing so you can note
         down its physical color with a pen!
    2. Long screen time for LIVE X, Y, Z motion & tilt angle inspection.
       - Displays real-time acceleration (X, Y, Z in g-units) and Pitch/Roll angles.
       - Lets you tilt the device in hand to physically observe which axis
         responds to forward/backward pitch, left/right roll, or vertical bounce.
    3. Press and hold Button 1 (GPIO 23) for 2 seconds to toggle LCD backlight ON/OFF.
    4. Press Button 2 (GPIO 32) at any time to FREEZE/LOCK the MPU screen permanently
       for continuous angle testing, or click again to resume LED testing!
    5. NO Wi-Fi, NO Web, NO Cloud - 100% standalone, fast, and offline.
  =============================================================================
  Hardware Connections:
    - LCD 16x2 I2C: SDA = GPIO 21, SCL = GPIO 22 (Address 0x27 or 0x3F auto-detected)
    - MPU-6050 IMU: SDA = GPIO 21, SCL = GPIO 22 (Address 0x68)
    - 4 Test LEDs :
        * Pin 1 = GPIO 4
        * Pin 2 = GPIO 5
        * Pin 3 = GPIO 18
        * Pin 4 = GPIO 19
    - Button 1    : GPIO 23 (Active LOW, internal pull-up) -> 2s Hold toggles LCD Backlight
    - Button 2    : GPIO 32 (Active LOW, internal pull-up) -> Click toggles MPU Lock Mode
    - Piezo Buzzer: GPIO 25 (Active HIGH) -> Confirmation chirps
  =============================================================================
*/

#include <Arduino.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>

// ======================================================
// PIN DEFINITIONS
// ======================================================
constexpr uint8_t SDA_PIN    = 21;
constexpr uint8_t SCL_PIN    = 22;

// The 4 diagnostic LED pins to identify
constexpr uint8_t TEST_LED_PINS[] = {4, 5, 18, 19};
constexpr uint8_t NUM_LEDS        = sizeof(TEST_LED_PINS) / sizeof(TEST_LED_PINS[0]);

constexpr uint8_t BUTTON_1   = 23;  // Hold 2s -> LCD Backlight Toggle
constexpr uint8_t BUTTON_2   = 32;  // Click   -> Lock on MPU Motion Screen
constexpr uint8_t BUZZER_PIN = 25;  // Audio feedback

// ======================================================
// TIMING CONSTANTS
// ======================================================
constexpr uint32_t LED_PERIOD_MS       = 2000; // 2 seconds per LED
constexpr uint32_t MPU_SCREEN_TIME_MS  = 12000; // 12 seconds on MPU screen during auto-cycle
constexpr uint32_t HOLD_BACKLIGHT_MS   = 2000; // Hold Button 1 for 2s for backlight
constexpr uint32_t MPU_REFRESH_MS      = 150;  // Update MPU values every 150ms on LCD

// ======================================================
// OBJECTS & STATE VARIABLES
// ======================================================
LiquidCrystal_I2C lcd(0x27, 16, 2);
bool lcdFound          = false;
bool lcdBacklightState = true;
bool mpuFound          = false;

// Operating Modes
enum TestState {
  STATE_LED_CYCLE,
  STATE_MPU_MOTION
};

TestState currentState = STATE_LED_CYCLE;
uint8_t   currentLedIndex = 0;
uint32_t  stateEnteredAt  = 0;
uint32_t  lastMpuSampleAt = 0;
bool      lockMpuScreen   = false; // When true, stays on MPU screen indefinitely

// MPU-6050 Motion Variables
float accelX = 0.0f;
float accelY = 0.0f;
float accelZ = 0.0f;
float pitchDeg = 0.0f;
float rollDeg  = 0.0f;
float tiltDeg  = 0.0f;

// Button Handling
struct BtnState {
  uint8_t  pin;
  bool     rawPressed;
  bool     pressed;
  uint32_t changedAt;
  uint32_t pressedAt;
  bool     holdHandled;
};

BtnState btn1 = {BUTTON_1, false, false, 0, 0, false};
BtnState btn2 = {BUTTON_2, false, false, 0, 0, false};

// Non-blocking Buzzer
uint32_t buzzerStopAt = 0;

void chirpBuzzer(uint16_t durationMs = 40) {
  digitalWrite(BUZZER_PIN, HIGH);
  buzzerStopAt = millis() + durationMs;
}

// ======================================================
// LCD HELPER (FLICKER-FREE LINE PRINTING)
// ======================================================
void lcdPrintLine(uint8_t row, const char *str) {
  if (!lcdFound) return;
  char buffer[17];
  snprintf(buffer, sizeof(buffer), "%-16.16s", str);
  lcd.setCursor(0, row);
  lcd.print(buffer);
}

// ======================================================
// I2C & MPU-6050 ENGINE
// ======================================================
bool checkI2C(uint8_t addr) {
  Wire.beginTransmission(addr);
  return (Wire.endTransmission() == 0);
}

bool initMpu() {
  if (!checkI2C(0x68)) return false;

  // Wake up MPU-6050 (clear sleep bit in PWR_MGMT_1, reg 0x6B)
  Wire.beginTransmission(0x68);
  Wire.write(0x6B);
  Wire.write(0x00);
  if (Wire.endTransmission() != 0) return false;

  // Set Accelerometer range to +/- 4g (reg 0x1C, value 0x08)
  Wire.beginTransmission(0x68);
  Wire.write(0x1C);
  Wire.write(0x08);
  Wire.endTransmission();

  // Set Gyroscope range to +/- 500 deg/s (reg 0x1B, value 0x08)
  Wire.beginTransmission(0x68);
  Wire.write(0x1B);
  Wire.write(0x08);
  Wire.endTransmission();

  return true;
}

void readMpu() {
  if (!mpuFound) return;

  Wire.beginTransmission(0x68);
  Wire.write(0x3B); // ACCEL_XOUT_H
  if (Wire.endTransmission(false) != 0 || Wire.requestFrom(0x68, 6) != 6) {
    return;
  }

  int16_t rawX = (Wire.read() << 8) | Wire.read();
  int16_t rawY = (Wire.read() << 8) | Wire.read();
  int16_t rawZ = (Wire.read() << 8) | Wire.read();

  // For +/- 4g range, scale is 8192 LSB/g
  accelX = rawX / 8192.0f;
  accelY = rawY / 8192.0f;
  accelZ = rawZ / 8192.0f;

  // Calculate Roll & Pitch angles in degrees
  rollDeg  = atan2f(accelY, accelZ) * RAD_TO_DEG;
  pitchDeg = atan2f(-accelX, sqrtf(accelY * accelY + accelZ * accelZ)) * RAD_TO_DEG;
  tiltDeg  = atan2f(hypotf(accelX, accelY), accelZ) * RAD_TO_DEG;
}

// ======================================================
// BUTTON READER (WITH 2S HOLD BACKLIGHT TOGGLE)
// ======================================================
void updateButtons(uint32_t now) {
  // --- BUTTON 1 (GPIO 23): 2s Hold for Backlight ---
  bool b1Raw = (digitalRead(btn1.pin) == LOW);
  if (b1Raw != btn1.rawPressed) {
    btn1.rawPressed = b1Raw;
    btn1.changedAt  = now;
  }
  if (now - btn1.changedAt >= 35) {
    if (b1Raw != btn1.pressed) {
      btn1.pressed = b1Raw;
      if (btn1.pressed) {
        btn1.pressedAt   = now;
        btn1.holdHandled = false;
      } else {
        btn1.holdHandled = false;
      }
    } else if (btn1.pressed && !btn1.holdHandled) {
      if (now - btn1.pressedAt >= HOLD_BACKLIGHT_MS) {
        btn1.holdHandled = true;
        lcdBacklightState = !lcdBacklightState;
        if (lcdFound) {
          if (lcdBacklightState) lcd.backlight();
          else lcd.noBacklight();
        }
        chirpBuzzer(60);
        Serial.printf("[LCD] 2-Second Hold on B1 -> Backlight is now %s\n",
                      lcdBacklightState ? "ON" : "OFF");
      }
    }
  }

  // --- BUTTON 2 (GPIO 32): Single Click to Lock/Unlock MPU Screen ---
  bool b2Raw = (digitalRead(btn2.pin) == LOW);
  if (b2Raw != btn2.rawPressed) {
    btn2.rawPressed = b2Raw;
    btn2.changedAt  = now;
  }
  if (now - btn2.changedAt >= 35) {
    if (b2Raw != btn2.pressed) {
      btn2.pressed = b2Raw;
      if (btn2.pressed) {
        // Button 2 Clicked down!
        lockMpuScreen = !lockMpuScreen;
        chirpBuzzer(40);

        if (lockMpuScreen) {
          currentState = STATE_MPU_MOTION;
          // Turn off all test LEDs when locking to MPU
          for (uint8_t p : TEST_LED_PINS) digitalWrite(p, LOW);
          Serial.println("[MODE] Locked on LIVE MPU-6050 Motion Screen!");
        } else {
          currentState = STATE_LED_CYCLE;
          currentLedIndex = 0;
          stateEnteredAt = now;
          Serial.println("[MODE] Resumed LED Pin Sequencing!");
        }
      }
    }
  }
}

// ======================================================
// SETUP
// ======================================================
void setup() {
  Serial.begin(115200);
  delay(100);
  Serial.println("\n==================================================");
  Serial.println("  PROJECT CHALOK: HARDWARE DIAGNOSTIC TEST SKETCH  ");
  Serial.println("==================================================");

  // Initialize Buzzer
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);

  // Initialize all 4 LED pins as OUTPUT, initially LOW
  for (uint8_t pin : TEST_LED_PINS) {
    pinMode(pin, OUTPUT);
    digitalWrite(pin, LOW);
  }

  // Initialize Buttons
  pinMode(BUTTON_1, INPUT_PULLUP);
  pinMode(BUTTON_2, INPUT_PULLUP);

  // Initialize I2C Bus
  Wire.begin(SDA_PIN, SCL_PIN, 100000);
  Wire.setTimeOut(50);

  // Detect and initialize 16x2 LCD
  if (checkI2C(0x27)) {
    lcd = LiquidCrystal_I2C(0x27, 16, 2);
    lcdFound = true;
  } else if (checkI2C(0x3F)) {
    lcd = LiquidCrystal_I2C(0x3F, 16, 2);
    lcdFound = true;
  }

  if (lcdFound) {
    lcd.init();
    lcd.backlight();
    lcdBacklightState = true;
    lcd.clear();
    lcdPrintLine(0, "CHALOK TEST RIG");
    lcdPrintLine(1, "Starting test...");
    chirpBuzzer(50);
    delay(1000);
  } else {
    Serial.println("[WARN] LCD not found on I2C address 0x27 or 0x3F!");
  }

  // Initialize MPU-6050
  mpuFound = initMpu();
  if (mpuFound) {
    Serial.println("[INIT] MPU-6050 detected and initialized successfully!");
  } else {
    Serial.println("[WARN] MPU-6050 NOT detected on address 0x68!");
  }

  // Start with first LED
  stateEnteredAt = millis();
  digitalWrite(TEST_LED_PINS[0], HIGH);
  Serial.printf("[TEST] Starting LED Test: Pin GPIO %d is ON for 2s\n", TEST_LED_PINS[0]);
}

// ======================================================
// MAIN LOOP
// ======================================================
void loop() {
  uint32_t now = millis();

  // Handle non-blocking buzzer turn-off
  if (buzzerStopAt > 0 && now >= buzzerStopAt) {
    digitalWrite(BUZZER_PIN, LOW);
    buzzerStopAt = 0;
  }

  // Check buttons (Button 1: 2s hold backlight | Button 2: Toggle MPU lock)
  updateButtons(now);

  // ====================================================
  // STATE MACHINE: LED CYCLE vs LIVE MPU MOTION SCREEN
  // ====================================================
  if (currentState == STATE_LED_CYCLE) {
    // Turn ON only the current LED, turn OFF all others
    for (uint8_t i = 0; i < NUM_LEDS; ++i) {
      digitalWrite(TEST_LED_PINS[i], (i == currentLedIndex) ? HIGH : LOW);
    }

    // Display LED pin on LCD
    char line1[17];
    char line2[17];
    snprintf(line1, sizeof(line1), "TESTING LEDS [%d/%d]", currentLedIndex + 1, NUM_LEDS);
    snprintf(line2, sizeof(line2), "GLOWING: GPIO %d", TEST_LED_PINS[currentLedIndex]);
    lcdPrintLine(0, line1);
    lcdPrintLine(1, line2);

    // After 2 seconds, advance to next LED
    if (now - stateEnteredAt >= LED_PERIOD_MS) {
      stateEnteredAt = now;
      currentLedIndex++;

      // When all 4 LEDs have been tested for 2 seconds each:
      if (currentLedIndex >= NUM_LEDS) {
        currentLedIndex = 0;
        // Turn off all LEDs
        for (uint8_t p : TEST_LED_PINS) digitalWrite(p, LOW);

        // Switch to MPU Motion screen
        currentState = STATE_MPU_MOTION;
        chirpBuzzer(30);
        Serial.println("[TEST] Completed 4-LED cycle -> Showing LIVE MPU-6050 Motion Screen!");
      } else {
        Serial.printf("[TEST] Next LED: Pin GPIO %d is now ON for 2s\n", TEST_LED_PINS[currentLedIndex]);
      }
    }
  }
  else if (currentState == STATE_MPU_MOTION) {
    // Ensure all test LEDs stay OFF during MPU inspection
    for (uint8_t p : TEST_LED_PINS) digitalWrite(p, LOW);

    // Sample MPU and refresh LCD every 150 ms
    if (now - lastMpuSampleAt >= MPU_REFRESH_MS) {
      lastMpuSampleAt = now;
      readMpu();

      if (mpuFound) {
        // Line 0: Real-time X and Y Acceleration in g-units
        // Line 1: Real-time Z Acceleration and Pitch/Roll Angle in degrees
        char line1[17];
        char line2[17];

        // Format: "X:+0.02  Y:-0.15"
        snprintf(line1, sizeof(line1), "X:%+0.2f Y:%+0.2f", accelX, accelY);

        // Format: "Z:%+0.2f P:%+02.0f%c"
        // Note: 'L' indicates LOCKED mode if Button 2 was clicked
        if (lockMpuScreen) {
          snprintf(line2, sizeof(line2), "Z:%+0.2f Pit:%+03.0fL", accelZ, pitchDeg);
        } else {
          snprintf(line2, sizeof(line2), "Z:%+0.2f Pit:%+03.0f ", accelZ, pitchDeg);
        }

        lcdPrintLine(0, line1);
        lcdPrintLine(1, line2);

        // Also stream to Serial Monitor for detailed observation
        Serial.printf("[MPU] X:%+0.2fg | Y:%+0.2fg | Z:%+0.2fg | Pitch:%+05.1f deg | Roll:%+05.1f deg\n",
                      accelX, accelY, accelZ, pitchDeg, rollDeg);
      } else {
        lcdPrintLine(0, "MPU-6050 ERROR");
        lcdPrintLine(1, "Check I2C Wiring");
      }
    }

    // If NOT locked by Button 2, stay on MPU screen for MPU_SCREEN_TIME_MS (12 seconds)
    // then restart the LED cycle!
    if (!lockMpuScreen) {
      if (now - stateEnteredAt >= MPU_SCREEN_TIME_MS) {
        currentState = STATE_LED_CYCLE;
        currentLedIndex = 0;
        stateEnteredAt = now;
        chirpBuzzer(30);
        Serial.println("[TEST] Returning to LED Pin Cycle test...");
      }
    }
  }
}
