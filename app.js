// =============================================================================
// CHALOK LIVE GPS TRACKER - GOOGLE MATERIAL DARK OBSIDIAN ENGINE
// =============================================================================

// 1. Firebase RTDB Configuration
const firebaseConfig = window.firebaseConfig || {
  apiKey: "AIzaSyBc8wZeR65Mxwax0WV-7VmxLKz_tFDUsGE",
  authDomain: "track-test-4ddde.firebaseapp.com",
  databaseURL: "https://track-test-4ddde-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "track-test-4ddde",
  storageBucket: "track-test-4ddde.firebasestorage.app",
  messagingSenderId: "111986334538",
  appId: "1:111986334538:web:e146f1a84595f7603cbfb3",
  measurementId: "G-WPSZZ4H6H1"
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);
const db = firebase.database();

// =============================================================================
// GLOBAL STATE
// =============================================================================
let map = null;
let modalMap = null;
let trackerMarker = null;
let activeRecordingPolyline = null;
let modalPolyline = null;
let modalCasing = null;
let modalStartMarker = null;
let modalEndMarker = null;

let currentMode = 'rider'; // 'rider' | 'admin'
let isSharingActive = false;
let hasReceivedFirstFix = false;

// Movement & Speed State
let lastCoords = { lat: null, lng: null };
let lastSpeedCalcCoords = { lat: null, lng: null, time: null };
let currentSpeedKmh = 0.0;
let animationFrameId = null;

// Telemetry & Last Active Device Record Clock
// "The purpose of the record is when was the last active data we received from the device and not the current one. The last means the very last moment before the device went standby"
let lastActiveWallTime = null;
let lastActiveDeviceTs = null;

try {
  const cached = localStorage.getItem('chalok_last_active_record');
  if (cached) {
    const parsed = JSON.parse(cached);
    lastActiveWallTime = parsed.wallTime || null;
    lastActiveDeviceTs = parsed.deviceTs || null;
  }
} catch (e) {}

// Admin Journey Recording State
let isRecordingTrip = false;
let tripSession = {
  startTime: null,
  timerInterval: null,
  points: [],
  totalDistMeters: 0,
  lastRecordedCoord: null
};

// Trips History Cache
let tripsHistoryCache = {};

// =============================================================================
// LEAFLET MAP INITIALIZATION (High-Detail Texture Layers Retained)
// =============================================================================
let isAutoCenteringEnabled = true;

function initMainMap() {
  // Check if we have last tested coordinates saved in localStorage to avoid sticking to Lalbagh
  let defaultLat = 23.7684; // Default to East West University / Aftabnagar area
  let defaultLng = 90.4265;
  try {
    const cached = localStorage.getItem('chalok_last_known_coords');
    if (cached) {
      const p = JSON.parse(cached);
      if (p.lat && p.lng && !isNaN(p.lat) && !isNaN(p.lng)) {
        defaultLat = p.lat;
        defaultLng = p.lng;
      }
    }
  } catch (e) {}

  map = L.map('map', {
    zoomControl: false,
    attributionControl: true
  }).setView([defaultLat, defaultLng], 16);

  // Position zoom controls nicely
  L.control.zoom({ position: 'bottomleft' }).addTo(map);

  // High-Detail Base Layers (Google Detailed Streets, OSM HOT, Hybrid)
  const detailedStreets = L.tileLayer('https://mt{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}', {
    maxZoom: 20,
    subdomains: '0123',
    attribution: '&copy; Google Maps'
  });

  const osmHumanitarian = L.tileLayer('https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap'
  });

  const satelliteHybrid = L.tileLayer('https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', {
    maxZoom: 20,
    subdomains: '0123',
    attribution: '&copy; Google Satellite'
  });

  detailedStreets.addTo(map);

  const baseMaps = {
    "Detailed Streets": detailedStreets,
    "OSM Humanitarian": osmHumanitarian,
    "Satellite Hybrid": satelliteHybrid
  };
  L.control.layers(baseMaps, null, { position: 'topright' }).addTo(map);

  // Custom DivIcon for Vehicle Marker using Lucide Map-Pin SVG
  const trackerIcon = L.divIcon({
    className: 'custom-tracker-pin-marker',
    html: `
      <div class="pin-pulse-halo"></div>
      <div class="pin-container">
        <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-map-pin chalok-pin-svg">
          <path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/>
          <circle cx="12" cy="10" r="3"/>
        </svg>
      </div>
    `,
    iconSize: [32, 40],
    iconAnchor: [16, 36],
    popupAnchor: [0, -36]
  });

  trackerMarker = L.marker([defaultLat, defaultLng], { icon: trackerIcon }).addTo(map);
  trackerMarker.bindPopup('<b>CHALOK Vehicle</b><br>Standby position');

  // Recenter button listener with active state toggle
  const btnRecenter = document.getElementById('btnRecenter');
  if (btnRecenter) {
    btnRecenter.classList.add('active'); // active by default on load
    btnRecenter.addEventListener('click', () => {
      isAutoCenteringEnabled = true;
      btnRecenter.classList.add('active');
      if (lastCoords.lat !== null && lastCoords.lng !== null) {
        map.flyTo([lastCoords.lat, lastCoords.lng], 17, { duration: 0.8 });
      }
    });
  }

  // Detect when user manually explores the map -> pause auto-follow
  map.on('dragstart', () => {
    isAutoCenteringEnabled = false;
    if (btnRecenter) btnRecenter.classList.remove('active');
  });

  // Multiple staged size invalidations to ensure full rendering on phones
  setTimeout(ensureMapRender, 100);
  setTimeout(ensureMapRender, 300);
  setTimeout(ensureMapRender, 800);
}

function ensureMapRender() {
  if (map) {
    map.invalidateSize();
    if (lastCoords.lat !== null && lastCoords.lng !== null) {
      map.panTo([lastCoords.lat, lastCoords.lng], { animate: false });
    }
  }
}

// Modal Map Initialization (Created lazily)
function getModalMap() {
  if (!modalMap) {
    modalMap = L.map('modalMap', {
      zoomControl: true,
      attributionControl: false
    }).setView([23.7186, 90.3837], 15);

    L.tileLayer('https://mt{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}', {
      maxZoom: 20,
      subdomains: '0123'
    }).addTo(modalMap);
  }
  return modalMap;
}

// =============================================================================
// HAVERSINE DISTANCE & SPEED CALCULATION
// =============================================================================
function calcDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000; // Earth radius in meters
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Compute speed smoothly from coordinate movement
function updateCalculatedSpeed(newLat, newLng) {
  const now = performance.now();

  if (lastSpeedCalcCoords.lat === null || lastSpeedCalcCoords.time === null) {
    lastSpeedCalcCoords = { lat: newLat, lng: newLng, time: now };
    currentSpeedKmh = 0.0;
    renderSpeedUI(0.0);
    return;
  }

  const distMeters = calcDistanceMeters(
    lastSpeedCalcCoords.lat,
    lastSpeedCalcCoords.lng,
    newLat,
    newLng
  );
  const dtSec = (now - lastSpeedCalcCoords.time) / 1000;

  // Stationarity filter: movement under 2.5 meters in 3 seconds is drift / jitter
  if (distMeters < 2.5) {
    currentSpeedKmh = 0.0;
    renderSpeedUI(0.0);
    return;
  }

  if (dtSec >= 1.0) {
    const rawSpeed = (distMeters / dtSec) * 3.6; // m/s to km/h
    
    // Discard unrealistic GPS multi-path teleport jumps (>130 km/h)
    if (rawSpeed < 130) {
      // Exponential moving average filter (40% new, 60% current)
      currentSpeedKmh = (currentSpeedKmh * 0.6) + (rawSpeed * 0.4);
    }
    
    lastSpeedCalcCoords = { lat: newLat, lng: newLng, time: now };
    renderSpeedUI(currentSpeedKmh);
  }
}

function renderSpeedUI(speed) {
  const formatted = speed > 0.4 ? speed.toFixed(1) : '0.0';
  document.getElementById('speedVal').textContent = formatted;
  document.getElementById('telemSpeed').textContent = `${formatted} km/h`;

  const speedStatusEl = document.getElementById('speedStatus');
  if (speedStatusEl) {
    if (speed < 0.8) speedStatusEl.textContent = 'Stationary';
    else if (speed < 20) speedStatusEl.textContent = 'Cruising slow';
    else speedStatusEl.textContent = 'Moving in transit';
  }

  const liveTripSpeedEl = document.getElementById('liveTripSpeed');
  if (liveTripSpeedEl) {
    liveTripSpeedEl.innerHTML = `${formatted} <small>km/h</small>`;
  }
}

// =============================================================================
// KINEMATIC POSITION FILTER & MULTIPATH ANTI-BOUNCE ENGINE
// =============================================================================
// Filters urban canyon GPS reflections (satellite bouncing from building walls)
// without street-snapping, preserving off-road, field, and terrace paths.
let filteredPos = { lat: null, lng: null };
let lastFilterPacketTime = null;
let lastMarkerPacketTime = null;

function applyKinematicFilter(rawLat, rawLng, sats = 0) {
  const now = performance.now();

  // First reading: initialize filter directly
  if (filteredPos.lat === null || filteredPos.lng === null) {
    filteredPos = { lat: rawLat, lng: rawLng };
    lastFilterPacketTime = now;
    return { lat: rawLat, lng: rawLng };
  }

  const dtSec = lastFilterPacketTime ? Math.max((now - lastFilterPacketTime) / 1000, 0.5) : 3.0;
  lastFilterPacketTime = now;

  const rawDistMeters = calcDistanceMeters(filteredPos.lat, filteredPos.lng, rawLat, rawLng);
  const rawSpeedKmh = (rawDistMeters / dtSec) * 3.6;

  // 1. Stationary Deadband Suppression:
  // When testing on hand or stopping at a terrace/hostel gate, GPS multipath jitter
  // causes 2-4 meter random squiggles into building walls. Clamp to stationary.
  if (rawDistMeters < 2.0) {
    return { lat: filteredPos.lat, lng: filteredPos.lng };
  }

  // 2. Outlier Teleport Jump Rejection (Multipath Wall Reflection):
  // When walking or e-rickshaw riding, sudden jumps > 35m in 3s (> 42 km/h) are reflections
  if (rawSpeedKmh > 55.0) {
    // Heavily damp the teleport jump by clamping max displacement
    const maxAllowedDist = 12.0 * dtSec; // max ~43 km/h
    const ratio = maxAllowedDist / rawDistMeters;
    rawLat = filteredPos.lat + (rawLat - filteredPos.lat) * ratio;
    rawLng = filteredPos.lng + (rawLng - filteredPos.lng) * ratio;
  }

  // 3. Adaptive Exponential Smoothing (EMA):
  // If satellite count is low (poor PDOP / heavy urban canyon), smooth more aggressively.
  // If moving briskly with high satellite count, follow more responsively.
  let alpha = 0.55;
  if (sats >= 8 && rawSpeedKmh > 8.0) {
    alpha = 0.75; // Confident movement: follow responsive trajectory
  } else if (rawSpeedKmh < 4.0 || sats < 5) {
    alpha = 0.38; // Walking / multipath canyon: heavier smoothing against lateral wall bounces
  }

  filteredPos.lat = filteredPos.lat + alpha * (rawLat - filteredPos.lat);
  filteredPos.lng = filteredPos.lng + alpha * (rawLng - filteredPos.lng);

  return { lat: filteredPos.lat, lng: filteredPos.lng };
}

// Chaikin's Corner-Cutting Spline Smoothing Algorithm
// Turns jagged polygonal GPS line segments into smooth organic trajectories
function chaikinSmooth(points, iterations = 1) {
  if (!points || points.length <= 2) return points;
  let smoothed = points;
  for (let it = 0; it < iterations; it++) {
    const next = [];
    next.push(smoothed[0]); // Preserve start point exactly
    for (let i = 0; i < smoothed.length - 1; i++) {
      const p0 = smoothed[i];
      const p1 = smoothed[i + 1];
      // Q = 0.75 * p0 + 0.25 * p1
      const q = [0.75 * p0[0] + 0.25 * p1[0], 0.75 * p0[1] + 0.25 * p1[1]];
      // R = 0.25 * p0 + 0.75 * p1
      const r = [0.25 * p0[0] + 0.75 * p1[0], 0.25 * p0[1] + 0.75 * p1[1]];
      next.push(q);
      next.push(r);
    }
    next.push(smoothed[smoothed.length - 1]); // Preserve end point exactly
    smoothed = next;
  }
  return smoothed;
}

// =============================================================================
// CONTINUOUS FLUID MARKER ANIMATION (ZERO STUTTER ENGINE)
// =============================================================================
function animateMarker(newLat, newLng) {
  if (lastCoords.lat === null || lastCoords.lng === null) {
    lastCoords = { lat: newLat, lng: newLng };
    trackerMarker.setLatLng([newLat, newLng]);
    return;
  }

  const dist = calcDistanceMeters(lastCoords.lat, lastCoords.lng, newLat, newLng);
  if (dist < 0.8) return; // Microscopic threshold

  const now = performance.now();
  let packetInterval = 3000;
  if (lastMarkerPacketTime !== null) {
    const dt = now - lastMarkerPacketTime;
    if (dt >= 800 && dt <= 8000) {
      packetInterval = dt;
    }
  }
  lastMarkerPacketTime = now;

  // Fluid duration matches the actual telemetry cycle (e.g. 2600ms for 3s gap)
  // Completely eliminates the 800ms jump + 2.2s dead freeze stutter!
  const duration = Math.min(Math.max(packetInterval * 0.90, 1000), 4500);

  const startLat = lastCoords.lat;
  const startLng = lastCoords.lng;
  const startTime = performance.now();

  if (animationFrameId) cancelAnimationFrame(animationFrameId);

  function step(time) {
    const progress = Math.min((time - startTime) / duration, 1);
    // Smooth cubic ease-out
    const ease = 1 - Math.pow(1 - progress, 3);

    const curLat = startLat + (newLat - startLat) * ease;
    const curLng = startLng + (newLng - startLng) * ease;

    trackerMarker.setLatLng([curLat, curLng]);

    if (progress < 1) {
      animationFrameId = requestAnimationFrame(step);
    } else {
      lastCoords = { lat: newLat, lng: newLng };
    }
  }

  animationFrameId = requestAnimationFrame(step);
}

// =============================================================================
// DEVICE RECORDED TIMESTAMP & AGE TICKER (1-Second Engine)
// =============================================================================
function updateLastRecordedDisplay() {
  const pillText = document.getElementById('lastRecordedText');
  const telemText = document.getElementById('telemLastRec');

  if (!lastActiveWallTime) {
    if (pillText) pillText.textContent = isSharingActive ? 'Streaming live...' : 'Waiting for device...';
    if (telemText) telemText.textContent = isSharingActive ? 'Streaming live...' : 'Waiting for device...';
    return;
  }

  const elapsedSec = Math.floor((Date.now() - lastActiveWallTime) / 1000);
  let relativeAgeStr = '';

  if (elapsedSec < 5) {
    relativeAgeStr = 'Just now';
  } else if (elapsedSec < 60) {
    relativeAgeStr = `${elapsedSec}s ago`;
  } else if (elapsedSec < 3600) {
    const m = Math.floor(elapsedSec / 60);
    relativeAgeStr = `${m}m ago`;
  } else {
    const h = Math.floor(elapsedSec / 3600);
    relativeAgeStr = `>${h}h ago`;
  }

  // Determine actual recorded clock time
  let clockTimeStr = '';
  if (lastActiveDeviceTs && lastActiveDeviceTs > 1577836800000) {
    // GPS Real-world UTC epoch
    const d = new Date(lastActiveDeviceTs);
    clockTimeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } else {
    // Wall time receipt of device packet
    const d = new Date(lastActiveWallTime);
    clockTimeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  if (isSharingActive) {
    const fullDisplay = `Live: ${clockTimeStr} (${relativeAgeStr})`;
    if (pillText) pillText.innerHTML = `<span class="rec-prefix live">Live:</span> ${clockTimeStr} (${relativeAgeStr})`;
    if (telemText) telemText.textContent = fullDisplay;
  } else {
    const fullDisplay = `Last Active: ${clockTimeStr} (${relativeAgeStr} • Standby)`;
    if (pillText) pillText.innerHTML = `<span class="rec-prefix standby">Last Active:</span> ${clockTimeStr} (${relativeAgeStr} • Standby)`;
    if (telemText) telemText.textContent = fullDisplay;
  }
}

setInterval(updateLastRecordedDisplay, 1000);

// =============================================================================
// FIREBASE REALTIME LISTENERS
// =============================================================================
function setupFirebaseListeners() {
  // A. Connection Status
  db.ref('.info/connected').on('value', (snap) => {
    const badge = document.getElementById('connectionBadge');
    const label = document.getElementById('connectionText');
    if (snap.val() === true) {
      badge.className = 'status-pill connected';
      label.textContent = 'Live Connected';
    } else {
      badge.className = 'status-pill disconnected';
      label.textContent = 'Offline';
    }
  });

  // B. Tracker Sharing Status (tracker/active)
  let prevSharingActiveState = null;
  db.ref('tracker/active').on('value', (snap) => {
    const newSharingActive = (snap.val() === true);
    const rideJustEnded = (prevSharingActiveState === true && !newSharingActive);
    prevSharingActiveState = newSharingActive;
    isSharingActive = newSharingActive;
    
    // Update Floating Ride Pill
    const sharingPill = document.getElementById('rideSharingBadge');
    const sharingLabel = document.getElementById('rideSharingLabel');
    if (sharingPill && sharingLabel) {
      if (isSharingActive) {
        sharingPill.className = 'sharing-pill active';
        sharingLabel.textContent = 'SHARING ACTIVE';
      } else {
        sharingPill.className = 'sharing-pill stopped';
        sharingLabel.textContent = 'STANDBY';
      }
    }

    // When ride ends (device stops sharing or goes standby), immediately halt active recording
    if (rideJustEnded) {
      handleRideEnded();
    }

    // Refresh Admin Journey Recording State & Last Recorded Display
    updateAdminRecordingUI();
    updateLastRecordedDisplay();
    if (typeof updateKinematicsStandbyStatus === 'function') {
      updateKinematicsStandbyStatus();
    }
  });

  // C. Live Telemetry & GPS Coordinates (tracker/current)
  db.ref('tracker/current').on('value', (snap) => {
    const data = snap.val();
    if (!data) return;

    // Only update "last active data" when the device is actively sharing!
    // "The purpose of the record is when was the last active data we received from the device and not the current one. The last means the very last moment before the device went standby"
    if (isSharingActive) {
      lastActiveWallTime = Date.now();
      lastActiveDeviceTs = data.timestamp || null;
      try {
        localStorage.setItem('chalok_last_active_record', JSON.stringify({
          wallTime: lastActiveWallTime,
          deviceTs: lastActiveDeviceTs
        }));
      } catch (e) {}
      updateLastRecordedDisplay();
    }

    const lat = parseFloat(data.lat);
    const lng = parseFloat(data.lng);
    const sats = data.satellites || 0;

    // Acceleration X, Y, Z (in g)
    const ax = data.ax !== undefined ? parseFloat(data.ax) : 0.0;
    const ay = data.ay !== undefined ? parseFloat(data.ay) : 0.0;
    const az = data.az !== undefined ? parseFloat(data.az) : 0.0;

    // Angles: Tilt, Roll, Pitch
    const tilt = data.tilt !== undefined ? parseFloat(data.tilt) : 0.0;
    const roll = data.roll !== undefined ? parseFloat(data.roll) : 0.0;
    const pitch = data.pitch !== undefined ? parseFloat(data.pitch) : 0.0;

    // Update Telemetry & UI Cards
    document.getElementById('satsVal').textContent = sats;
    document.getElementById('gpsFixStatus').textContent = sats >= 4 ? '3D GPS Fix' : (data.assisted ? 'A-GPS (Wi-Fi Seed)' : 'Searching Sky');
    document.getElementById('tiltVal').textContent = tilt.toFixed(1);
    document.getElementById('tiltSubtext').textContent = `Roll: ${roll.toFixed(1)}° | Pitch: ${pitch.toFixed(1)}°`;

    // MPU chips on Ride Card
    document.getElementById('accelX').textContent = (ax >= 0 ? '+' : '') + ax.toFixed(2) + ' g';
    document.getElementById('accelY').textContent = (ay >= 0 ? '+' : '') + ay.toFixed(2) + ' g';
    document.getElementById('accelZ').textContent = (az >= 0 ? '+' : '') + az.toFixed(2) + ' g';

    // Telemetry View Page Elements
    document.getElementById('telemTilt').textContent = `${tilt.toFixed(1)}°`;
    document.getElementById('telemRoll').textContent = `${roll.toFixed(1)}°`;
    document.getElementById('telemPitch').textContent = `${pitch.toFixed(1)}°`;
    document.getElementById('telemSats').textContent = `${sats} satellites`;
    document.getElementById('telemAxVal').textContent = `${(ax >= 0 ? '+' : '') + ax.toFixed(2)} g`;
    document.getElementById('telemAyVal').textContent = `${(ay >= 0 ? '+' : '') + ay.toFixed(2)} g`;
    document.getElementById('telemAzVal').textContent = `${(az >= 0 ? '+' : '') + az.toFixed(2)} g`;

    // Fill bars for G-force (normalized between -2g and +2g => 0% to 100%)
    const pctX = Math.min(Math.max(((ax + 2) / 4) * 100, 5), 95);
    const pctY = Math.min(Math.max(((ay + 2) / 4) * 100, 5), 95);
    const pctZ = Math.min(Math.max(((az + 2) / 4) * 100, 5), 95);
    document.getElementById('barAx').style.width = `${pctX}%`;
    document.getElementById('barAy').style.width = `${pctY}%`;
    document.getElementById('barAz').style.width = `${pctZ}%`;

    // Stream live to Kinematics Motion Lab HUD & Data Logger
    if (typeof updateKinematicsTelemetry === 'function') {
      updateKinematicsTelemetry({
        ax, ay, az, tilt, roll, pitch,
        speed: currentSpeedKmh,
        timestamp: data.timestamp || Date.now(),
        deviceMillis: data.deviceMillis || 0
      });
    }

    // Coordinates
    if (!isNaN(lat) && !isNaN(lng)) {
      // Pass through Kinematic Filter (cancels multipath wall bounces)
      const smoothed = applyKinematicFilter(lat, lng, sats);
      const sLat = smoothed.lat;
      const sLng = smoothed.lng;

      document.getElementById('telemLat').textContent = sLat.toFixed(6);
      document.getElementById('telemLng').textContent = sLng.toFixed(6);

      const latEl = document.getElementById('coordLatVal');
      const lngEl = document.getElementById('coordLngVal');
      if (latEl) latEl.textContent = sLat.toFixed(6) + '°';
      if (lngEl) lngEl.textContent = sLng.toFixed(6) + '°';

      const pill = document.getElementById('coordsSourcePill');
      if (pill) {
        if (data.assisted) {
          pill.textContent = 'A-GPS (Wi-Fi)';
          pill.classList.add('pill-agps');
        } else {
          pill.textContent = sats >= 4 ? '3D FIX' : 'GPS';
          pill.classList.remove('pill-agps');
        }
      }

      // Animate Marker Smoothly (Continuous non-stuttering interpolation)
      animateMarker(sLat, sLng);

      // Save to localStorage so future page visits immediately open at the real location
      try {
        localStorage.setItem('chalok_last_known_coords', JSON.stringify({ lat: sLat, lng: sLng }));
      } catch (e) {}

      // Intelligent Reactive Map Centering:
      // If first fix received, OR if device relocated significantly (> 250m away from current map view)
      if (map) {
        const curCenter = map.getCenter();
        const distFromCenter = calcDistanceMeters(curCenter.lat, curCenter.lng, sLat, sLng);

        if (!hasReceivedFirstFix || distFromCenter > 250) {
          map.flyTo([sLat, sLng], 17, { duration: hasReceivedFirstFix ? 1.2 : 0.6 });
          hasReceivedFirstFix = true;
          isAutoCenteringEnabled = true;
          const btnRecenter = document.getElementById('btnRecenter');
          if (btnRecenter) btnRecenter.classList.add('active');
        } else if (isAutoCenteringEnabled) {
          map.panTo([sLat, sLng], { animate: true, duration: 0.6 });
        }
      }

      // Calculate speed dynamically from coordinates movement
      updateCalculatedSpeed(sLat, sLng);

      // If Admin has started recording journey, append point
      if (isRecordingTrip) {
        handleTripPointRecording(sLat, sLng);
      }
    }
  });

  // D. Trips History Listener (history/)
  db.ref('history').on('value', (snap) => {
    tripsHistoryCache = snap.val() || {};
    renderTripsList(tripsHistoryCache);
  });
}

// =============================================================================
// ADMIN JOURNEY RECORDING WORKFLOW
// =============================================================================
function handleRideEnded() {
  // If an admin trip recording session was active when the ride ended:
  if (isRecordingTrip) {
    clearInterval(tripSession.timerInterval);
    const ptsCount = tripSession.points.length;
    
    // Auto-save the completed ride if sufficient points were collected
    if (ptsCount >= 2) {
      const durationSeconds = Math.max(1, Math.floor((Date.now() - tripSession.startTime) / 1000));
      const distanceKm = parseFloat((tripSession.totalDistMeters / 1000).toFixed(2));
      const now = new Date();
      const dateFormatted = now.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric'
      });
      const timeFormatted = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      const tripRecord = {
        title: `Ride on ${dateFormatted} at ${timeFormatted}`,
        savedAt: firebase.database.ServerValue.TIMESTAMP,
        formattedDate: `${dateFormatted}, ${timeFormatted}`,
        distanceKm: distanceKm,
        durationSeconds: durationSeconds,
        durationFormatted: formatDuration(durationSeconds),
        pointsCount: ptsCount,
        startCoords: tripSession.points[0] || { lat: 0, lng: 0 },
        endCoords: tripSession.points[ptsCount - 1] || { lat: 0, lng: 0 },
        points: tripSession.points
      };

      // Reset recording state immediately so active recorder never lingers
      isRecordingTrip = false;
      tripSession.points = [];
      tripSession.totalDistMeters = 0;
      tripSession.lastRecordedCoord = null;
      if (activeRecordingPolyline && map) {
        map.removeLayer(activeRecordingPolyline);
        activeRecordingPolyline = null;
      }
      const timerEl = document.getElementById('recordingTimer');
      if (timerEl) timerEl.textContent = "00:00:00";

      db.ref('history').push(tripRecord).then(() => {
        reloadJourneysPage();
      }).catch(err => {
        console.error("Auto-save on ride end failed:", err);
        reloadJourneysPage();
      });
    } else {
      // Discard incomplete session
      isRecordingTrip = false;
      tripSession.points = [];
      tripSession.totalDistMeters = 0;
      tripSession.lastRecordedCoord = null;
      if (activeRecordingPolyline && map) {
        map.removeLayer(activeRecordingPolyline);
        activeRecordingPolyline = null;
      }
      const timerEl = document.getElementById('recordingTimer');
      if (timerEl) timerEl.textContent = "00:00:00";
    }
  }

  // Ensure recording UI is cleared and journeys page reloaded
  updateAdminRecordingUI();
  reloadJourneysPage();
}

function updateAdminRecordingUI() {
  const adminRecordingBar = document.getElementById('adminRecordingBar');
  const warningBox = document.getElementById('adminSharingWarning');
  const readyBox = document.getElementById('adminReadyBox');
  const recordingBox = document.getElementById('adminRecordingBox');

  if (!adminRecordingBar) return;

  // Only visible when currentMode === 'admin'
  if (currentMode !== 'admin') {
    adminRecordingBar.classList.add('hidden');
    return;
  }
  adminRecordingBar.classList.remove('hidden');

  // Validation: When device is NOT sharing (ride ended or in standby), NEVER show active recorder
  if (!isSharingActive) {
    if (warningBox) warningBox.classList.remove('hidden');
    if (readyBox) readyBox.classList.add('hidden');
    if (recordingBox) recordingBox.classList.add('hidden');
  } else {
    if (warningBox) warningBox.classList.add('hidden');
    if (isRecordingTrip) {
      if (readyBox) readyBox.classList.add('hidden');
      if (recordingBox) recordingBox.classList.remove('hidden');
    } else {
      if (readyBox) readyBox.classList.remove('hidden');
      if (recordingBox) recordingBox.classList.add('hidden');
    }
  }
}

function handleTripPointRecording(lat, lng) {
  if (!tripSession.lastRecordedCoord) {
    tripSession.lastRecordedCoord = { lat, lng };
    tripSession.points.push({ lat, lng, timestamp: Date.now(), speed: currentSpeedKmh });
    updateActivePolyline();
    return;
  }

  const distMeters = calcDistanceMeters(
    tripSession.lastRecordedCoord.lat,
    tripSession.lastRecordedCoord.lng,
    lat,
    lng
  );

  // Record point if moved >= 1.6 meters (captures sharp road turns while ignoring stationary knots)
  if (distMeters >= 1.6) {
    tripSession.totalDistMeters += distMeters;
    tripSession.lastRecordedCoord = { lat, lng };
    tripSession.points.push({ lat, lng, timestamp: Date.now(), speed: currentSpeedKmh });

    // Update Live Stats
    const distKm = (tripSession.totalDistMeters / 1000).toFixed(2);
    document.getElementById('liveTripDist').innerHTML = `${distKm} <small>km</small>`;
    document.getElementById('liveTripPoints').innerHTML = `${tripSession.points.length} <small>pts</small>`;

    updateActivePolyline();
  }
}

function updateActivePolyline() {
  const rawLatLngs = tripSession.points.map(p => [p.lat, p.lng]);
  // Apply Chaikin corner-cutting spline smoothing to eliminate jagged building edges
  const smoothedLatLngs = chaikinSmooth(rawLatLngs, 1);
  if (!activeRecordingPolyline) {
    activeRecordingPolyline = L.polyline(smoothedLatLngs, {
      color: '#5e35b1', // Dark purple for high contrast route plotting
      weight: 5,
      opacity: 0.95,
      lineCap: 'round',
      lineJoin: 'round'
    }).addTo(map);
  } else {
    activeRecordingPolyline.setLatLngs(smoothedLatLngs);
  }
}

function setupAdminRecordingControls() {
  const btnStart = document.getElementById('btnStartRecording');
  const btnEnd = document.getElementById('btnEndRecording');
  const btnCancel = document.getElementById('btnCancelRecording');
  const timerEl = document.getElementById('recordingTimer');

  // Start Trip Recording
  btnStart.addEventListener('click', () => {
    if (!isSharingActive) {
      alert("Cannot record journey: The device is currently STOPPED. Start sharing on the device first.");
      return;
    }

    isRecordingTrip = true;
    tripSession.startTime = Date.now();
    tripSession.points = [];
    tripSession.totalDistMeters = 0;
    tripSession.lastRecordedCoord = null;

    if (activeRecordingPolyline) {
      map.removeLayer(activeRecordingPolyline);
      activeRecordingPolyline = null;
    }

    // Add current location if available
    if (lastCoords.lat !== null && lastCoords.lng !== null) {
      tripSession.lastRecordedCoord = { lat: lastCoords.lat, lng: lastCoords.lng };
      tripSession.points.push({
        lat: lastCoords.lat,
        lng: lastCoords.lng,
        timestamp: Date.now(),
        speed: currentSpeedKmh
      });
      updateActivePolyline();
    }

    // Start Running Timer
    clearInterval(tripSession.timerInterval);
    tripSession.timerInterval = setInterval(() => {
      const elapsedSec = Math.floor((Date.now() - tripSession.startTime) / 1000);
      const hrs = String(Math.floor(elapsedSec / 3600)).padStart(2, '0');
      const mins = String(Math.floor((elapsedSec % 3600) / 60)).padStart(2, '0');
      const secs = String(elapsedSec % 60).padStart(2, '0');
      timerEl.textContent = `${hrs}:${mins}:${secs}`;
    }, 1000);

    updateAdminRecordingUI();
  });

  // End & Save Journey
  btnEnd.addEventListener('click', () => {
    if (tripSession.points.length < 2) {
      const confirmSave = confirm("The trip has very few recorded points. Do you still want to save it?");
      if (!confirmSave) return;
    }

    clearInterval(tripSession.timerInterval);
    const durationSeconds = Math.max(1, Math.floor((Date.now() - tripSession.startTime) / 1000));
    const distanceKm = parseFloat((tripSession.totalDistMeters / 1000).toFixed(2));
    const now = new Date();

    const dateFormatted = now.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
    const timeFormatted = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const tripRecord = {
      title: `Trip on ${dateFormatted} at ${timeFormatted}`,
      savedAt: firebase.database.ServerValue.TIMESTAMP,
      formattedDate: `${dateFormatted}, ${timeFormatted}`,
      distanceKm: distanceKm,
      durationSeconds: durationSeconds,
      durationFormatted: formatDuration(durationSeconds),
      pointsCount: tripSession.points.length,
      startCoords: tripSession.points[0] || { lat: 0, lng: 0 },
      endCoords: tripSession.points[tripSession.points.length - 1] || { lat: 0, lng: 0 },
      points: tripSession.points
    };

    // 1. Reset recording state immediately so active recorder disappears instantly
    isRecordingTrip = false;
    tripSession.points = [];
    tripSession.totalDistMeters = 0;
    tripSession.lastRecordedCoord = null;
    if (activeRecordingPolyline && map) {
      map.removeLayer(activeRecordingPolyline);
      activeRecordingPolyline = null;
    }
    if (timerEl) timerEl.textContent = "00:00:00";
    updateAdminRecordingUI();

    // 2. Save to Firebase RTDB under /history
    db.ref('history').push(tripRecord).then(() => {
      // 3. Reload journeys page with fresh database data and open Journeys view
      reloadJourneysPage().then(() => {
        switchView('viewTrips');
      });
    }).catch(err => {
      console.error("Error saving trip:", err);
      alert("Failed to save trip to database: " + err.message);
      reloadJourneysPage().then(() => {
        switchView('viewTrips');
      });
    });
  });

  // Cancel & Discard
  btnCancel.addEventListener('click', () => {
    if (confirm("Discard this trip recording session?")) {
      clearInterval(tripSession.timerInterval);
      isRecordingTrip = false;
      tripSession.points = [];
      tripSession.totalDistMeters = 0;
      tripSession.lastRecordedCoord = null;
      if (activeRecordingPolyline && map) {
        map.removeLayer(activeRecordingPolyline);
        activeRecordingPolyline = null;
      }
      if (timerEl) timerEl.textContent = "00:00:00";
      updateAdminRecordingUI();
      reloadJourneysPage();
    }
  });
}

function formatDuration(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s}s`;
}

// =============================================================================
// TRIP HISTORY RENDERING & CLEAR HISTORY TOOL
// =============================================================================
function reloadJourneysPage() {
  return db.ref('history').once('value').then(snap => {
    tripsHistoryCache = snap.val() || {};
    renderTripsList(tripsHistoryCache);
    return tripsHistoryCache;
  }).catch(err => {
    console.warn("Reload journeys failed, using cache:", err);
    renderTripsList(tripsHistoryCache);
    return tripsHistoryCache;
  });
}

function renderTripsList(historyData) {
  const container = document.getElementById('tripsList');
  if (!container) return;
  container.innerHTML = '';

  const keys = Object.keys(historyData || {});
  const shouldShowActiveCard = isRecordingTrip && isSharingActive;

  if (keys.length === 0 && !shouldShowActiveCard) {
    container.innerHTML = `
      <div class="empty-trips-state">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="12" cy="12" r="10"></circle>
          <polyline points="12 6 12 12 16 14"></polyline>
        </svg>
        <h4>No Recorded Journeys Yet</h4>
        <p>When Admin records a journey during live sharing, it will appear here with distance and route plottings.</p>
      </div>
    `;
    return;
  }

  // Active orders section (ONLY when currently recording AND ride is actively sharing)
  if (shouldShowActiveCard) {
    const activeHeader = document.createElement('div');
    activeHeader.className = 'trips-section-title';
    activeHeader.textContent = 'Active orders';
    container.appendChild(activeHeader);

    const curDistKm = (tripSession.totalDistMeters / 1000).toFixed(2);
    const activeCard = document.createElement('div');
    activeCard.className = 'uber-trip-card active-live-trip';
    activeCard.innerHTML = `
      <div class="trip-card-main">
        <div class="trip-route-timeline">
          <div class="timeline-point">
            <span class="point-dot start"></span>
            <div class="point-text-block">
              <span class="point-address">${tripSession.points[0] ? `${tripSession.points[0].lat.toFixed(4)}, ${tripSession.points[0].lng.toFixed(4)}` : 'Live Fleet Position'}</span>
              <span class="point-role-caption">Pickup point</span>
            </div>
          </div>
          <div class="timeline-point">
            <span class="point-dot end live-pulse"></span>
            <div class="point-text-block">
              <span class="point-address">Vehicle Broadcasting</span>
              <span class="point-role-caption">Recording in progress</span>
            </div>
          </div>
        </div>
        <div class="trip-right-col">
          <div class="trip-metric-item">
            <span class="m-caption">Status</span>
            <span class="m-val accent-val">RECORDING</span>
          </div>
          <div class="trip-metric-item">
            <span class="m-caption">Distance</span>
            <span class="m-val dist-val">${curDistKm} km</span>
          </div>
        </div>
      </div>
    `;
    container.appendChild(activeCard);
  }

  // Past orders section
  const pastHeader = document.createElement('div');
  pastHeader.className = 'trips-section-title';
  pastHeader.textContent = 'Past orders';
  container.appendChild(pastHeader);

  // Reverse to show latest first
  keys.reverse().forEach(key => {
    const trip = historyData[key];
    const dist = trip.distanceKm !== undefined ? trip.distanceKm : (trip.totalDistanceKm || 0.0);
    const duration = trip.durationFormatted || (trip.durationSeconds ? formatDuration(trip.durationSeconds) : '--');
    const ptsCount = trip.pointsCount || (trip.points ? Object.keys(trip.points).length : 0);

    const startLat = trip.startCoords?.lat ? trip.startCoords.lat.toFixed(4) : '--';
    const startLng = trip.startCoords?.lng ? trip.startCoords.lng.toFixed(4) : '--';
    const endLat = trip.endCoords?.lat ? trip.endCoords.lat.toFixed(4) : '--';
    const endLng = trip.endCoords?.lng ? trip.endCoords.lng.toFixed(4) : '--';

    // Pretty address names matching Uber UI
    let originName = `${startLat}, ${startLng}`;
    let destName = `${endLat}, ${endLng}`;
    if (trip.title && trip.title.toLowerCase().includes('lalbagh')) {
      originName = 'Lalbagh Fort, Old Dhaka';
      destName = 'New Market, Mirpur Rd';
    } else if (trip.originName) {
      originName = trip.originName;
      destName = trip.destinationName || destName;
    }

    const card = document.createElement('div');
    card.className = 'uber-trip-card';
    card.innerHTML = `
      <div class="trip-card-main">
        <div class="trip-route-timeline">
          <div class="timeline-point">
            <span class="point-dot start"></span>
            <div class="point-text-block">
              <span class="point-address">${originName}</span>
              <span class="point-role-caption">Pickup point</span>
            </div>
          </div>
          <div class="timeline-point">
            <span class="point-dot end"></span>
            <div class="point-text-block">
              <span class="point-address">${destName}</span>
              <span class="point-role-caption">Destination</span>
            </div>
          </div>
        </div>

        <div class="trip-right-col">
          <div class="trip-metric-item">
            <span class="m-caption">Payment</span>
            <span class="m-val fare-val">৳45</span>
          </div>
          <div class="trip-metric-item">
            <span class="m-caption">Distance</span>
            <span class="m-val dist-val">${Number(dist).toFixed(2)} km</span>
          </div>
        </div>
      </div>

      <div class="trip-card-footer">
        <div class="trip-meta-tags">
          <span>Duration: <b>${duration}</b></span>
          <span>Points: <b>${ptsCount}</b></span>
          <span class="trip-date">${trip.formattedDate || ''}</span>
        </div>
        <div class="trip-footer-actions">
          <button class="btn-view-route" data-key="${key}" title="View journey map route">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"></polygon>
            </svg>
            <span>View Route</span>
          </button>
          <button class="btn-delete-trip" data-key="${key}" title="Delete this journey record">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            </svg>
          </button>
        </div>
      </div>
    `;

    card.querySelector('.btn-view-route').addEventListener('click', () => {
      openTripModal(key, trip);
    });

    const btnDelete = card.querySelector('.btn-delete-trip');
    if (btnDelete) {
      btnDelete.addEventListener('click', (e) => {
        e.stopPropagation();
        const confirmed = confirm("Are you sure you want to delete this recorded journey from the database?");
        if (!confirmed) return;

        db.ref('history/' + key).remove().then(() => {
          // Deletion handled cleanly; Firebase realtime listener updates list automatically
        }).catch(err => {
          alert("Failed to delete journey: " + err.message);
        });
      });
    }

    container.appendChild(card);
  });
}

// Clear History Button
function setupClearHistoryButton() {
  document.getElementById('btnClearAllHistory').addEventListener('click', () => {
    const confirmed = confirm("Are you sure you want to permanently clear all recorded trip history from the database?");
    if (!confirmed) return;

    db.ref('history').remove().then(() => {
      alert("All journey history records have been cleared.");
    }).catch(err => {
      alert("Failed to clear history: " + err.message);
    });
  });
}

// =============================================================================
// FOCUSED TRIP MODAL (Fraction Rectangle Bounding Box Viewer - Uber Details)
// =============================================================================
function openTripModal(tripKey, trip) {
  const modal = document.getElementById('tripModal');
  modal.classList.remove('hidden');

  document.getElementById('modalTripTitle').textContent = trip.title || 'Recorded Journey';
  document.getElementById('modalDistance').textContent = `${Number(trip.distanceKm || 0).toFixed(2)} km`;
  document.getElementById('modalDuration').textContent = trip.durationFormatted || (trip.durationSeconds ? formatDuration(trip.durationSeconds) : '--');
  document.getElementById('modalPointsCount').textContent = `${trip.pointsCount || (trip.points ? Object.keys(trip.points).length : 0)} pts`;

  // Calculate Average Speed
  let avgSpeed = 0.0;
  if (trip.distanceKm && trip.durationSeconds && trip.durationSeconds > 0) {
    avgSpeed = (trip.distanceKm / (trip.durationSeconds / 3600)).toFixed(1);
  }
  document.getElementById('modalAvgSpeed').textContent = `${avgSpeed} km/h`;

  // Resolve origin and destination labels
  let originName = 'Trip Origin';
  let destName = 'Trip Destination';
  if (trip.title && trip.title.toLowerCase().includes('lalbagh')) {
    originName = 'Lalbagh Fort, Old Dhaka';
    destName = 'New Market, Mirpur Rd';
  } else if (trip.originName) {
    originName = trip.originName;
    destName = trip.destinationName || destName;
  } else if (trip.startCoords) {
    originName = `${trip.startCoords.lat.toFixed(4)}, ${trip.startCoords.lng.toFixed(4)}`;
    destName = trip.endCoords ? `${trip.endCoords.lat.toFixed(4)}, ${trip.endCoords.lng.toFixed(4)}` : 'Trip Destination';
  }

  const originEl = document.getElementById('modalOriginText');
  const destEl = document.getElementById('modalDestText');
  if (originEl) originEl.textContent = originName;
  if (destEl) destEl.textContent = destName;

  const m = getModalMap();
  setTimeout(() => {
    m.invalidateSize();

    // Clean up previous layers
    if (modalCasing) m.removeLayer(modalCasing);
    if (modalPolyline) m.removeLayer(modalPolyline);
    if (modalStartMarker) m.removeLayer(modalStartMarker);
    if (modalEndMarker) m.removeLayer(modalEndMarker);

    // Extract coordinate array
    const rawPoints = [];
    const val = trip.points;
    if (Array.isArray(val)) {
      val.forEach(p => { if (p) rawPoints.push(p); });
    } else if (typeof val === 'object' && val !== null) {
      Object.keys(val).forEach(k => { if (val[k]) rawPoints.push(val[k]); });
    }

    const coords = rawPoints
      .filter(p => !isNaN(parseFloat(p.lat)) && !isNaN(parseFloat(p.lng)))
      .map(p => [parseFloat(p.lat), parseFloat(p.lng)]);

    if (coords.length > 0) {
      // Apply Chaikin corner-cutting spline smoothing to historical replay paths
      const smoothedCoords = chaikinSmooth(coords, 1);

      // Google Maps style clean minimal route plot
      // Outer casing for high contrast against street map tiles
      modalCasing = L.polyline(smoothedCoords, {
        color: 'rgba(20, 10, 35, 0.85)',
        weight: 8,
        opacity: 0.85,
        lineCap: 'round',
        lineJoin: 'round'
      }).addTo(m);

      // Core route polyline in dark purple #5e35b1
      modalPolyline = L.polyline(smoothedCoords, {
        color: '#5e35b1',
        weight: 5,
        opacity: 1.0,
        lineCap: 'round',
        lineJoin: 'round'
      }).addTo(m);

      // Start pin (dark purple circle)
      modalStartMarker = L.circleMarker(smoothedCoords[0], {
        radius: 7,
        color: '#ffffff',
        fillColor: '#5e35b1',
        fillOpacity: 1,
        weight: 3
      }).addTo(m).bindPopup(`<b>Pickup:</b> ${originName}`);

      // End pin (sparkle coral circle)
      modalEndMarker = L.circleMarker(smoothedCoords[smoothedCoords.length - 1], {
        radius: 7,
        color: '#ffffff',
        fillColor: '#d96570',
        fillOpacity: 1,
        weight: 3
      }).addTo(m).bindPopup(`<b>Destination:</b> ${destName}`);

      // Strictly fit to the fraction rectangle bounding box covered by the device!
      const isMobile = window.innerWidth < 768;
      m.fitBounds(modalPolyline.getBounds(), {
        padding: isMobile ? [20, 20] : [45, 45],
        maxZoom: 18
      });

      // Extra staged invalidation for mobile devices
      setTimeout(() => {
        m.invalidateSize();
      }, 400);
    }
  }, 200);
}

function setupTripModalClose() {
  const modal = document.getElementById('tripModal');
  const btnClose = document.getElementById('btnCloseModal');
  const btnDismiss = document.getElementById('btnDismissModal');
  const backdrop = modal.querySelector('.modal-backdrop');

  if (btnClose) btnClose.addEventListener('click', () => modal.classList.add('hidden'));
  if (btnDismiss) btnDismiss.addEventListener('click', () => modal.classList.add('hidden'));
  if (backdrop) backdrop.addEventListener('click', () => modal.classList.add('hidden'));
}

// =============================================================================
// NAVIGATION & VIEW SWITCHING (DESKTOP & MOBILE ADAPTIVE)
// =============================================================================
function switchView(targetViewId) {
  document.querySelectorAll('.view-panel').forEach(panel => {
    panel.classList.remove('active-view');
  });

  const targetPanel = document.getElementById(targetViewId);
  if (targetPanel) {
    targetPanel.classList.add('active-view');
  }

  // Update both desktop nav tabs and mobile bottom nav tabs
  document.querySelectorAll('.desktop-nav-btn, .mobile-nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-view') === targetViewId);
  });

  // Re-render Leaflet when switching to Ride Map
  if (targetViewId === 'viewRide' && map) {
    setTimeout(ensureMapRender, 50);
    setTimeout(ensureMapRender, 200);
  }

  // Reload journeys list fresh when switching to Trips History
  if (targetViewId === 'viewTrips') {
    reloadJourneysPage();
  }
}

function setupNavigation() {
  document.querySelectorAll('.desktop-nav-btn, .mobile-nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const viewId = btn.getAttribute('data-view');
      switchView(viewId);
    });
  });

  // Handle window resizing and mobile orientation changes
  window.addEventListener('resize', () => {
    ensureMapRender();
  });
  window.addEventListener('orientationchange', () => {
    setTimeout(ensureMapRender, 200);
  });
}

// =============================================================================
// RIDER VS ADMIN MODE SWITCHER (TACTILE MICRO-ANIMATIONS)
// =============================================================================
let modeToastTimeout = null;

function showModeSwitchToast(mode) {
  const toast = document.getElementById('modeSwitchToast');
  const iconWrap = document.getElementById('modeToastIcon');
  const textEl = document.getElementById('modeToastText');
  if (!toast || !iconWrap || !textEl) return;

  if (modeToastTimeout) clearTimeout(modeToastTimeout);

  toast.classList.remove('hidden', 'dismissing');

  if (mode === 'admin') {
    toast.classList.add('admin-active');
    iconWrap.innerHTML = `
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
        <path d="m9 12 2 2 4-4"></path>
      </svg>
    `;
    textEl.textContent = 'Admin Mode Active (Journey Controls)';
  } else {
    toast.classList.remove('admin-active');
    iconWrap.innerHTML = `
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
        <circle cx="12" cy="7" r="4"></circle>
      </svg>
    `;
    textEl.textContent = 'Rider Mode Active (Live Telemetry)';
  }

  modeToastTimeout = setTimeout(() => {
    toast.classList.add('dismissing');
    setTimeout(() => {
      toast.classList.add('hidden');
      toast.classList.remove('dismissing');
    }, 350);
  }, 2200);
}

function setAppMode(mode, triggeredByUser = false) {
  currentMode = mode;
  const btnRider = document.getElementById('btnRiderMode');
  const btnAdmin = document.getElementById('btnAdminMode');

  if (btnRider && btnAdmin) {
    btnRider.classList.toggle('active', mode === 'rider');
    btnAdmin.classList.toggle('active', mode === 'admin');
  }

  updateAdminRecordingUI();

  if (triggeredByUser) {
    showModeSwitchToast(mode);
  }
}

function setupModeSwitcher() {
  const btnRider = document.getElementById('btnRiderMode');
  const btnAdmin = document.getElementById('btnAdminMode');

  if (btnRider) {
    btnRider.addEventListener('click', () => setAppMode('rider', true));
  }

  if (btnAdmin) {
    btnAdmin.addEventListener('click', () => setAppMode('admin', true));
  }
}

// =============================================================================
// KINEMATIC MOTION LAB & 6-DOF TELEMETRY LOGGER ENGINE
// =============================================================================

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

const KINEMATIC_MANEUVERS = {
  speed_breaker: {
    key: 'speed_breaker',
    name: 'Speed Breaker',
    title: 'Speed Breaker Detection Lab',
    tag: 'VERTICAL PITCH TRANSIENT (+PITCH → CREST → -PITCH)',
    desc: 'Simulate driving over an elevated speed breaker or road hump. Move device forward while tilting the front wheel upward, leveling briefly at the peak, then pitching down as rear clears.',
    guideSteps: [
      { step: '1. Approach:', desc: 'Level forward motion (Pitch ~0°)' },
      { step: '2. Climb:', desc: 'Nose pitches upward (+15° to +35°)' },
      { step: '3. Crest & Descend:', desc: 'Level crest (~0°), then pitch down (-15° to -30°)' }
    ],
    primaryMetric: 'Pitch (°)',
    getPeakMetric: (samples) => {
      if (!samples || samples.length === 0) return 'Peak: 0.0°';
      let maxPitch = -Infinity, minPitch = Infinity;
      samples.forEach(s => {
        if (s.pitch > maxPitch) maxPitch = s.pitch;
        if (s.pitch < minPitch) minPitch = s.pitch;
      });
      return `Peak: ${maxPitch > -Infinity ? (maxPitch >= 0 ? '+' : '') + maxPitch.toFixed(1) : '0.0'}° / Min: ${minPitch < Infinity ? (minPitch >= 0 ? '+' : '') + minPitch.toFixed(1) : '0.0'}°`;
    },
    classifySample: (sample) => {
      if (sample.pitch >= 12.0) return { text: 'FRONT_RISE', cls: 'tag-pitch-up' };
      if (sample.pitch <= -12.0) return { text: 'REAR_DESCENT', cls: 'tag-pitch-down' };
      if (Math.abs(sample.pitch) < 6.0 && (Math.abs(sample.ax - 1.0) > 0.18 || Math.abs(sample.az) > 0.12)) {
        return { text: 'CREST_LEVEL', cls: 'tag-steady' };
      }
      return { text: 'APPROACH_LEVEL', cls: 'tag-steady' };
    }
  },
  pothole: {
    key: 'pothole',
    name: 'Pothole / Dip',
    title: 'Pothole & Road Cavity Detection Lab',
    tag: 'VERTICAL ACCELERATION TRANSIENT (DROP → REBOUND SHOCK)',
    desc: 'Simulate hitting a road depression or pothole: sudden vertical acceleration plunge (Ax drops towards 0g) followed by sharp rebound upward impact shock (> 1.35g).',
    guideSteps: [
      { step: '1. Steady Ride:', desc: 'Normal 1.0g vertical baseline' },
      { step: '2. Cavity Drop:', desc: 'Sudden plunge downwards (Ax drops towards 0g)' },
      { step: '3. Rebound Shock:', desc: 'Sharp upward impact rebound (Ax spikes > 1.35g)' }
    ],
    primaryMetric: 'Ax Impact (g)',
    getPeakMetric: (samples) => {
      if (!samples || samples.length === 0) return 'Peak: 0.00g';
      let maxAx = -Infinity, minAx = Infinity;
      samples.forEach(s => {
        if (s.ax > maxAx) maxAx = s.ax;
        if (s.ax < minAx) minAx = s.ax;
      });
      return `Rebound: +${maxAx > -Infinity ? maxAx.toFixed(2) : '0.00'}g / Drop: ${minAx < Infinity ? minAx.toFixed(2) : '0.00'}g`;
    },
    classifySample: (sample) => {
      if (sample.ax <= 0.70) return { text: 'CAVITY_PLUNGE', cls: 'tag-pitch-down' };
      if (sample.ax >= 1.35) return { text: 'REBOUND_SHOCK', cls: 'tag-heave' };
      return { text: 'ROAD_BASELINE', cls: 'tag-steady' };
    }
  },
  forward: {
    key: 'forward',
    name: 'Forward Move',
    title: 'Forward Linear Acceleration Lab',
    tag: 'LONGITUDINAL TRANSLATION (+AZ SURGE)',
    desc: 'Move device straight ahead along its longitudinal axis to calibrate forward acceleration (Az) thresholds and identify cruising velocity.',
    guideSteps: [
      { step: '1. Neutral Rest:', desc: 'Stationary baseline (Az ~ 0.0g)' },
      { step: '2. Forward Surge:', desc: 'Smooth thrust forward along heading (+Az > 0.18g)' },
      { step: '3. Cruise / Coast:', desc: 'Constant velocity coasting' }
    ],
    primaryMetric: 'Az Thrust (g)',
    getPeakMetric: (samples) => {
      if (!samples || samples.length === 0) return 'Peak: 0.00g';
      let maxAz = -Infinity;
      samples.forEach(s => { if (s.az > maxAz) maxAz = s.az; });
      return `Max Thrust: +${maxAz > -Infinity ? maxAz.toFixed(2) : '0.00'}g`;
    },
    classifySample: (sample) => {
      if (sample.az >= 0.20) return { text: 'FORWARD_SURGE', cls: 'tag-speed' };
      if (sample.az <= -0.15) return { text: 'COAST_DECEL', cls: 'tag-pitch-down' };
      return { text: 'STEADY_CRUISE', cls: 'tag-steady' };
    }
  },
  backward: {
    key: 'backward',
    name: 'Backward Move',
    title: 'Backward / Reverse Movement Lab',
    tag: 'REVERSE TRANSLATION (-AZ PULL)',
    desc: 'Move device straight backward along its longitudinal axis to calibrate reverse motion indicators and negative longitudinal acceleration.',
    guideSteps: [
      { step: '1. Neutral Rest:', desc: 'Stationary baseline (Az ~ 0.0g)' },
      { step: '2. Reverse Pull:', desc: 'Smooth pull backwards (-Az < -0.18g)' },
      { step: '3. Stop Halt:', desc: 'Stop motion and bring to rest' }
    ],
    primaryMetric: 'Az Reverse (g)',
    getPeakMetric: (samples) => {
      if (!samples || samples.length === 0) return 'Peak: 0.00g';
      let minAz = Infinity;
      samples.forEach(s => { if (s.az < minAz) minAz = s.az; });
      return `Min Az: ${minAz < Infinity ? minAz.toFixed(2) : '0.00'}g`;
    },
    classifySample: (sample) => {
      if (sample.az <= -0.18) return { text: 'REVERSE_PULL', cls: 'tag-lateral' };
      if (sample.az >= 0.18) return { text: 'BRAKE_HALT', cls: 'tag-brake' };
      return { text: 'NEUTRAL_REST', cls: 'tag-steady' };
    }
  },
  right_turn: {
    key: 'right_turn',
    name: 'Right Turn',
    title: 'Right Turn & Banking Lab',
    tag: 'LATERAL CENTRIPETAL & ROLL (+ROLL, +AY)',
    desc: 'Move forward while rotating and banking clockwise to the right. Calibrate centripetal lateral g-force (+Ay) and positive lean angle (+Roll).',
    guideSteps: [
      { step: '1. Turn Entry:', desc: 'Straight approach (Roll ~0°, Ay ~0.0g)' },
      { step: '2. Right Apex:', desc: 'Clockwise bank to right (+Roll > 12°, +Ay > 0.20g)' },
      { step: '3. Exit / Upright:', desc: 'Return upright to straight path' }
    ],
    primaryMetric: 'Peak Bank (+Roll)',
    getPeakMetric: (samples) => {
      if (!samples || samples.length === 0) return 'Peak: 0.0°';
      let maxRoll = -Infinity, maxAy = -Infinity;
      samples.forEach(s => {
        if (s.roll > maxRoll) maxRoll = s.roll;
        if (s.ay > maxAy) maxAy = s.ay;
      });
      return `Roll: +${maxRoll > -Infinity ? maxRoll.toFixed(1) : '0.0'}° / Ay: +${maxAy > -Infinity ? maxAy.toFixed(2) : '0.00'}g`;
    },
    classifySample: (sample) => {
      if (sample.roll >= 12.0 || sample.ay >= 0.22) return { text: 'RIGHT_BANK_APEX', cls: 'tag-lateral' };
      if (sample.roll > 4.0 || sample.ay > 0.08) return { text: 'RIGHT_ENTRY', cls: 'tag-lateral' };
      return { text: 'STRAIGHT_PATH', cls: 'tag-steady' };
    }
  },
  left_turn: {
    key: 'left_turn',
    name: 'Left Turn',
    title: 'Left Turn & Banking Lab',
    tag: 'COUNTER LATERAL & ROLL (-ROLL, -AY)',
    desc: 'Move forward while rotating and banking counter-clockwise to the left. Calibrate negative lateral acceleration (-Ay) and negative lean angle (-Roll).',
    guideSteps: [
      { step: '1. Turn Entry:', desc: 'Straight approach (Roll ~0°, Ay ~0.0g)' },
      { step: '2. Left Apex:', desc: 'Counter-clockwise bank to left (-Roll < -12°, -Ay < -0.20g)' },
      { step: '3. Exit / Upright:', desc: 'Return upright to straight path' }
    ],
    primaryMetric: 'Peak Bank (-Roll)',
    getPeakMetric: (samples) => {
      if (!samples || samples.length === 0) return 'Peak: 0.0°';
      let minRoll = Infinity, minAy = Infinity;
      samples.forEach(s => {
        if (s.roll < minRoll) minRoll = s.roll;
        if (s.ay < minAy) minAy = s.ay;
      });
      return `Roll: ${minRoll < Infinity ? minRoll.toFixed(1) : '0.0'}° / Ay: ${minAy < Infinity ? minAy.toFixed(2) : '0.00'}g`;
    },
    classifySample: (sample) => {
      if (sample.roll <= -12.0 || sample.ay <= -0.22) return { text: 'LEFT_BANK_APEX', cls: 'tag-lateral' };
      if (sample.roll < -4.0 || sample.ay < -0.08) return { text: 'LEFT_ENTRY', cls: 'tag-lateral' };
      return { text: 'STRAIGHT_PATH', cls: 'tag-steady' };
    }
  },
  hard_brake: {
    key: 'hard_brake',
    name: 'Hard Braking',
    title: 'Hard Braking / Emergency Stop Lab',
    tag: 'RAPID LONGITUDINAL DECELERATION (-AZ SPIKE)',
    desc: 'Simulate an abrupt stop from motion: rapid longitudinal deceleration spike (-Az < -0.35g) coupled with nose pitch forward dip.',
    guideSteps: [
      { step: '1. Fast In-Motion:', desc: 'Forward movement at test speed' },
      { step: '2. Abrupt Halt:', desc: 'Sharp braking stop (-Az spike < -0.35g)' },
      { step: '3. Standstill:', desc: '0 km/h stationary halt' }
    ],
    primaryMetric: 'Max Decel (-Az)',
    getPeakMetric: (samples) => {
      if (!samples || samples.length === 0) return 'Peak: 0.00g';
      let minAz = Infinity;
      samples.forEach(s => { if (s.az < minAz) minAz = s.az; });
      return `Peak Decel: ${minAz < Infinity ? minAz.toFixed(2) : '0.00'}g`;
    },
    classifySample: (sample) => {
      if (sample.az <= -0.35) return { text: 'HARSH_DECEL_SPIKE', cls: 'tag-brake' };
      if (sample.speed <= 0.8 && sample.az > -0.15) return { text: 'FULL_STANDSTILL', cls: 'tag-steady' };
      return { text: 'TRANSIT_MOTION', cls: 'tag-steady' };
    }
  },
  overspeeding: {
    key: 'overspeeding',
    name: 'Overspeeding',
    title: 'Overspeeding Velocity Lab',
    tag: 'VELOCITY SURGE & SPEED THRESHOLD',
    desc: 'Calibrate walking baseline (3-5 km/h) versus running sprint (> 10 km/h) to establish reliable velocity surge alerts and speed limits.',
    guideSteps: [
      { step: '1. Walk Baseline:', desc: 'Walk steady pace (3 to 5 km/h)' },
      { step: '2. Velocity Surge:', desc: 'Run / sprint to exceed 10+ km/h' },
      { step: '3. Decel Recovery:', desc: 'Slow down to walking pace' }
    ],
    primaryMetric: 'Peak Speed (km/h)',
    getPeakMetric: (samples) => {
      if (!samples || samples.length === 0) return 'Peak: 0.0 km/h';
      let maxSpd = -Infinity;
      samples.forEach(s => { if (s.speed > maxSpd) maxSpd = s.speed; });
      return `Peak Speed: ${maxSpd > -Infinity ? maxSpd.toFixed(1) : '0.0'} km/h`;
    },
    classifySample: (sample) => {
      if (sample.speed >= 14.0) return { text: 'SEVERE_OVERSPEED', cls: 'tag-brake' };
      if (sample.speed >= 8.0) return { text: 'OVERSPEED_SURGE', cls: 'tag-speed' };
      if (sample.speed >= 2.5) return { text: 'WALK_BASELINE', cls: 'tag-steady' };
      return { text: 'IDLE_STATIC', cls: 'tag-steady' };
    }
  }
};

let currentManeuverKey = 'speed_breaker';
let isKinRecording = false;
let kinRecordStartTime = 0;
let kinRecordTimerInterval = null;
let kinSamplingInterval = null;
let kinCurrentRunSamples = [];
let kinRunsHistory = [];
let kinRunsFilter = 'current'; // 'current' or 'all'
let kinRunsSortOrder = 'latest'; // 'latest' or 'oldest'
let kinCurrentPage = 1;
const kinRunsPerPage = 6;
let activeModalRunId = null;
let kinLastStreamTime = 0;

let latestTelemSnapshot = {
  ax: 0.0,
  ay: 0.0,
  az: 0.0,
  tilt: 0.0,
  roll: 0.0,
  pitch: 0.0,
  speed: 0.0,
  timestamp: Date.now()
};

function loadKinematicsRunsFromStorage() {
  try {
    const raw = localStorage.getItem('chalok_kinematics_runs');
    if (raw) {
      kinRunsHistory = JSON.parse(raw) || [];
    }
  } catch (e) {
    console.warn("Could not load stored kinematics runs:", e);
    kinRunsHistory = [];
  }
}

function saveKinematicsRunsToStorage() {
  try {
    localStorage.setItem('chalok_kinematics_runs', JSON.stringify(kinRunsHistory));
  } catch (e) {
    console.warn("Could not save kinematics runs:", e);
  }
}

function updateKinematicsStandbyStatus() {
  const badge = document.getElementById('kinDeviceLinkBadge');
  const btnRecord = document.getElementById('btnToggleKinRecord');
  const btnText = document.getElementById('kinRecordBtnText');

  if (badge) {
    if (isSharingActive) {
      badge.className = 'link-status-badge active';
      badge.textContent = 'Device Connected (Active)';
    } else {
      badge.className = 'link-status-badge standby';
      badge.textContent = 'Device on Standby';
    }
  }

  // Safety: If device went into standby during an active recording run, halt and save
  if (isKinRecording && !isSharingActive) {
    stopKinematicsRecording();
    alert("Recording halted: Tracker went into STANDBY mode. The recorded run has been saved.");
    return;
  }

  if (!isKinRecording && btnRecord && btnText) {
    const cfg = KINEMATIC_MANEUVERS[currentManeuverKey];
    if (!isSharingActive) {
      btnRecord.classList.add('disabled-standby');
      btnRecord.classList.remove('idle', 'recording');
      btnRecord.title = 'Device is currently on standby. Press sharing button on tracker to record.';
      btnText.textContent = 'Standby - Start Sharing First';
    } else {
      btnRecord.classList.remove('disabled-standby');
      btnRecord.classList.add('idle');
      btnRecord.title = '';
      btnText.textContent = `Start Recording ${cfg ? cfg.name : ''}`;
    }
  }
}

function selectKinematicsManeuver(key) {
  if (!KINEMATIC_MANEUVERS[key]) return;
  currentManeuverKey = key;
  const cfg = KINEMATIC_MANEUVERS[key];

  // Update active pill button on desktop
  document.querySelectorAll('.kin-cat-btn').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-maneuver') === key);
  });

  // Sync mobile dropdown selector
  const mobSelect = document.getElementById('kinMobileSelect');
  if (mobSelect && mobSelect.value !== key) {
    mobSelect.value = key;
  }

  // Update stage header and instructions
  const tagEl = document.getElementById('kinActiveTag');
  const titleEl = document.getElementById('kinActiveTitle');
  const descEl = document.getElementById('kinActiveDesc');
  const guideEl = document.getElementById('kinMimicGuide');
  const btnText = document.getElementById('kinRecordBtnText');
  const btnRecord = document.getElementById('btnToggleKinRecord');

  if (tagEl) tagEl.textContent = cfg.tag;
  if (titleEl) titleEl.textContent = cfg.title;
  if (descEl) descEl.textContent = cfg.desc;

  if (guideEl && cfg.guideSteps) {
    guideEl.innerHTML = cfg.guideSteps.map(gs => `
      <div class="guide-step"><strong>${escapeHtml(gs.step)}</strong> ${escapeHtml(gs.desc)}</div>
    `).join('');
  }

  if (btnText && !isKinRecording) {
    if (!isSharingActive) {
      if (btnRecord) btnRecord.classList.add('disabled-standby');
      btnText.textContent = 'Standby - Start Sharing First';
    } else {
      if (btnRecord) {
        btnRecord.classList.remove('disabled-standby');
        btnRecord.classList.add('idle');
      }
      btnText.textContent = `Start Recording ${cfg.name}`;
    }
  }

  try {
    localStorage.setItem('chalok_kin_active_maneuver', key);
  } catch (e) {}

  // If filter is set to current, reset pagination to page 1 and re-render
  if (kinRunsFilter === 'current') {
    kinCurrentPage = 1;
    renderKinematicsRuns();
  }
}

function updateKinematicsHUDElements(telem) {
  const axEl = document.getElementById('hudAx');
  const ayEl = document.getElementById('hudAy');
  const azEl = document.getElementById('hudAz');
  const pitchEl = document.getElementById('hudPitch');
  const rollEl = document.getElementById('hudRoll');
  const speedEl = document.getElementById('hudSpeed');
  const streamStatus = document.getElementById('hudStreamStatus');
  const linkBadge = document.getElementById('kinDeviceLinkBadge');

  if (axEl) axEl.textContent = `${(telem.ax >= 0 ? '+' : '') + telem.ax.toFixed(2)} g`;
  if (ayEl) ayEl.textContent = `${(telem.ay >= 0 ? '+' : '') + telem.ay.toFixed(2)} g`;
  if (azEl) azEl.textContent = `${(telem.az >= 0 ? '+' : '') + telem.az.toFixed(2)} g`;
  if (pitchEl) pitchEl.textContent = `${(telem.pitch >= 0 ? '+' : '') + telem.pitch.toFixed(1)}°`;
  if (rollEl) rollEl.textContent = `${(telem.roll >= 0 ? '+' : '') + telem.roll.toFixed(1)}°`;
  if (speedEl) speedEl.textContent = `${telem.speed.toFixed(1)} km/h`;

  if (streamStatus) streamStatus.textContent = isSharingActive ? 'Stream: Active' : 'Stream: Standby';
  if (linkBadge) {
    if (isSharingActive) {
      linkBadge.textContent = 'Device Connected (Active)';
      linkBadge.className = 'link-status-badge active';
    } else {
      linkBadge.textContent = 'Device on Standby';
      linkBadge.className = 'link-status-badge standby';
    }
  }
}

function updateKinematicsTelemetry(telem) {
  kinLastStreamTime = Date.now();
  latestTelemSnapshot = {
    ax: telem.ax,
    ay: telem.ay,
    az: telem.az,
    tilt: telem.tilt,
    roll: telem.roll,
    pitch: telem.pitch,
    speed: telem.speed || 0.0,
    timestamp: telem.timestamp || Date.now()
  };

  updateKinematicsHUDElements(latestTelemSnapshot);

  // If currently recording and device is active, capture this live incoming hardware sample
  if (isKinRecording && isSharingActive) {
    recordKinematicsSample(latestTelemSnapshot);
  }
}

function recordKinematicsSample(snap) {
  const now = Date.now();
  const relTimeSec = Math.max(0, (now - kinRecordStartTime) / 1000);
  const d = new Date(now);
  const timeStr = d.toTimeString().split(' ')[0] + '.' + String(d.getMilliseconds()).padStart(3, '0');

  const maneuverCfg = KINEMATIC_MANEUVERS[currentManeuverKey];
  const classification = maneuverCfg && maneuverCfg.classifySample ? maneuverCfg.classifySample(snap) : { text: 'STEADY', cls: 'tag-steady' };

  const sample = {
    num: kinCurrentRunSamples.length + 1,
    relTimeSec: parseFloat(relTimeSec.toFixed(2)),
    timeStr,
    timestamp: now,
    ax: parseFloat(snap.ax.toFixed(2)),
    ay: parseFloat(snap.ay.toFixed(2)),
    az: parseFloat(snap.az.toFixed(2)),
    pitch: parseFloat(snap.pitch.toFixed(1)),
    roll: parseFloat(snap.roll.toFixed(1)),
    tilt: parseFloat(snap.tilt.toFixed(1)),
    speed: parseFloat(snap.speed.toFixed(1)),
    tagText: classification.text,
    tagCls: classification.cls
  };

  kinCurrentRunSamples.push(sample);

  // Update live sample count and live peak metric in UI
  const samplesEl = document.getElementById('kinLiveSamples');
  const peakEl = document.getElementById('kinLivePeakMetric');

  if (samplesEl) samplesEl.textContent = kinCurrentRunSamples.length;
  if (peakEl && maneuverCfg && maneuverCfg.getPeakMetric) {
    peakEl.textContent = maneuverCfg.getPeakMetric(kinCurrentRunSamples);
  }
}

function startKinematicsRecording() {
  // Prevent recording if device is on standby
  if (!isSharingActive) {
    alert("Cannot start recording: The device is currently on STANDBY.\nPress the sharing button on your physical tracker to start active sharing before recording kinematic maneuvers.");
    return;
  }

  const cfg = KINEMATIC_MANEUVERS[currentManeuverKey];
  isKinRecording = true;
  kinRecordStartTime = Date.now();
  kinCurrentRunSamples = [];

  const btnRecord = document.getElementById('btnToggleKinRecord');
  const btnText = document.getElementById('kinRecordBtnText');
  const liveStats = document.getElementById('kinLiveRecordStats');
  const liveTimer = document.getElementById('kinLiveTimer');
  const liveSamples = document.getElementById('kinLiveSamples');
  const livePeak = document.getElementById('kinLivePeakMetric');

  if (btnRecord) {
    btnRecord.classList.remove('idle', 'disabled-standby');
    btnRecord.classList.add('recording');
  }
  if (btnText) btnText.textContent = `Stop & Save Run`;
  if (liveStats) liveStats.classList.remove('hidden');
  if (liveTimer) liveTimer.textContent = '00:00.0';
  if (liveSamples) liveSamples.textContent = '0';
  if (livePeak) livePeak.textContent = 'Peak: --';

  // Capture initial baseline sample
  recordKinematicsSample(latestTelemSnapshot);

  // High-resolution interval timer for elapsed seconds
  clearInterval(kinRecordTimerInterval);
  kinRecordTimerInterval = setInterval(() => {
    if (!isKinRecording) return;
    const elapsedMs = Date.now() - kinRecordStartTime;
    const totalSec = Math.floor(elapsedMs / 1000);
    const mins = String(Math.floor(totalSec / 60)).padStart(2, '0');
    const secs = String(totalSec % 60).padStart(2, '0');
    const tenths = Math.floor((elapsedMs % 1000) / 100);
    if (liveTimer) {
      liveTimer.textContent = `${mins}:${secs}.${tenths}`;
    }
  }, 100);

  // Periodic sampler to capture steady high-resolution time series (every 350ms)
  clearInterval(kinSamplingInterval);
  kinSamplingInterval = setInterval(() => {
    if (!isKinRecording) return;
    recordKinematicsSample(latestTelemSnapshot);
  }, 350);
}

function stopKinematicsRecording() {
  if (!isKinRecording) return;
  isKinRecording = false;

  clearInterval(kinRecordTimerInterval);
  clearInterval(kinSamplingInterval);

  const cfg = KINEMATIC_MANEUVERS[currentManeuverKey];
  const btnRecord = document.getElementById('btnToggleKinRecord');
  const btnText = document.getElementById('kinRecordBtnText');
  const liveStats = document.getElementById('kinLiveRecordStats');

  if (btnRecord) {
    btnRecord.classList.remove('recording');
    if (!isSharingActive) {
      btnRecord.classList.add('disabled-standby');
    } else {
      btnRecord.classList.add('idle');
    }
  }
  if (btnText) {
    btnText.textContent = isSharingActive ? `Start Recording ${cfg.name}` : `Standby - Start Sharing First`;
  }
  if (liveStats) liveStats.classList.add('hidden');

  // If fewer than 2 samples, capture final snapshot
  if (kinCurrentRunSamples.length < 2) {
    recordKinematicsSample(latestTelemSnapshot);
  }

  const durationSec = Math.max(0.1, (Date.now() - kinRecordStartTime) / 1000);

  // Compute summary metrics for this run
  let maxPitch = -Infinity, minPitch = Infinity;
  let maxRoll = -Infinity, minRoll = Infinity;
  let maxAx = -Infinity, minAx = Infinity;
  let maxAy = -Infinity, minAy = Infinity;
  let maxAz = -Infinity, minAz = Infinity;
  let maxSpeed = -Infinity;

  kinCurrentRunSamples.forEach(s => {
    if (s.pitch > maxPitch) maxPitch = s.pitch;
    if (s.pitch < minPitch) minPitch = s.pitch;
    if (s.roll > maxRoll) maxRoll = s.roll;
    if (s.roll < minRoll) minRoll = s.roll;
    if (s.ax > maxAx) maxAx = s.ax;
    if (s.ax < minAx) minAx = s.ax;
    if (s.ay > maxAy) maxAy = s.ay;
    if (s.ay < minAy) minAy = s.ay;
    if (s.az > maxAz) maxAz = s.az;
    if (s.az < minAz) minAz = s.az;
    if (s.speed > maxSpeed) maxSpeed = s.speed;
  });

  const runId = 'kin_run_' + Date.now();
  const newRun = {
    id: runId,
    maneuver: currentManeuverKey,
    maneuverTitle: cfg.name,
    startTime: kinRecordStartTime,
    endTime: Date.now(),
    durationSec: parseFloat(durationSec.toFixed(1)),
    samples: [...kinCurrentRunSamples],
    peakMetric: cfg.getPeakMetric(kinCurrentRunSamples),
    summary: {
      maxPitch: maxPitch > -Infinity ? maxPitch : 0,
      minPitch: minPitch < Infinity ? minPitch : 0,
      maxRoll: maxRoll > -Infinity ? maxRoll : 0,
      minRoll: minRoll < Infinity ? minRoll : 0,
      maxAx: maxAx > -Infinity ? maxAx : 0,
      minAx: minAx < Infinity ? minAx : 0,
      maxAy: maxAy > -Infinity ? maxAy : 0,
      minAy: minAy < Infinity ? minAy : 0,
      maxAz: maxAz > -Infinity ? maxAz : 0,
      minAz: minAz < Infinity ? minAz : 0,
      maxSpeed: maxSpeed > -Infinity ? maxSpeed : 0
    }
  };

  // Prepend new run to history and save
  kinRunsHistory.unshift(newRun);
  saveKinematicsRunsToStorage();
  kinCurrentPage = 1; // reset to first page so new run is instantly in view
  renderKinematicsRuns();

  // Directly open the modal table dialog for this newly recorded record!
  openKinRunModal(runId);
}

function renderKinematicsRuns() {
  const container = document.getElementById('kinRunsList');
  const countBadge = document.getElementById('kinRunsCountBadge');
  const paginationBar = document.getElementById('kinPaginationBar');
  const paginationInfo = document.getElementById('kinPaginationInfo');
  const btnPrev = document.getElementById('btnKinPrevPage');
  const btnNext = document.getElementById('btnKinNextPage');
  if (!container) return;

  // 1. Filter
  let runs = kinRunsFilter === 'all'
    ? [...kinRunsHistory]
    : kinRunsHistory.filter(r => r.maneuver === currentManeuverKey);

  // 2. Sort by Latest or Oldest
  if (kinRunsSortOrder === 'oldest') {
    runs.sort((a, b) => a.startTime - b.startTime);
  } else {
    runs.sort((a, b) => b.startTime - a.startTime);
  }

  const totalRuns = runs.length;
  if (countBadge) {
    countBadge.textContent = `${totalRuns} Run${totalRuns === 1 ? '' : 's'}`;
  }

  if (totalRuns === 0) {
    const curName = KINEMATIC_MANEUVERS[currentManeuverKey]?.name || 'this maneuver';
    const totalRunsInHistory = kinRunsHistory.length;

    if (kinRunsFilter === 'current' && totalRunsInHistory > 0) {
      container.innerHTML = `
        <div class="kin-empty-state">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
            <polyline points="14 2 14 8 20 8"></polyline>
            <line x1="16" y1="13" x2="8" y2="13"></line>
            <line x1="16" y1="17" x2="8" y2="17"></line>
          </svg>
          <h4>No Recorded Runs for ${escapeHtml(curName)} Yet</h4>
          <p>You have <strong>${totalRunsInHistory} run(s)</strong> saved in other maneuver categories. Click <strong>"All Maneuvers"</strong> above to view all runs, or record a new run for ${escapeHtml(curName)}.</p>
        </div>
      `;
    } else {
      container.innerHTML = `
        <div class="kin-empty-state">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
            <polyline points="14 2 14 8 20 8"></polyline>
            <line x1="16" y1="13" x2="8" y2="13"></line>
            <line x1="16" y1="17" x2="8" y2="17"></line>
          </svg>
          <h4>No Recorded Runs for ${escapeHtml(curName)} Yet</h4>
          <p>Click "Start Recording", move the device to mimic ${escapeHtml(curName)}, then click "Stop & Save Run" to generate your tabular dataset.</p>
        </div>
      `;
    }
    if (paginationBar) paginationBar.style.display = 'none';
    return;
  }

  // 3. Pagination calculations
  const totalPages = Math.max(1, Math.ceil(totalRuns / kinRunsPerPage));
  if (kinCurrentPage > totalPages) kinCurrentPage = totalPages;
  if (kinCurrentPage < 1) kinCurrentPage = 1;

  const startIdx = (kinCurrentPage - 1) * kinRunsPerPage;
  const pagedRuns = runs.slice(startIdx, startIdx + kinRunsPerPage);

  // Render individual run cards with dedicated "Open Record Table" modal triggers
  container.innerHTML = pagedRuns.map(run => {
    const d = new Date(run.startTime);
    const dateFormatted = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    const timeFormatted = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    return `
      <div class="kin-run-card" id="runCard_${run.id}">
        <!-- Run Card Header -->
        <div class="kin-run-header">
          <div class="kin-run-meta">
            <span class="pill-calc">${escapeHtml(run.maneuverTitle || run.maneuver)}</span>
            <span class="kin-run-time">${dateFormatted} • ${timeFormatted}</span>
            <span class="kin-run-duration">Duration: ${run.durationSec}s</span>
            <span class="kin-run-samples-count">${run.samples.length} samples</span>
          </div>
          <span class="run-peak-badge">${escapeHtml(run.peakMetric)}</span>
        </div>

        <!-- 4-Tile Quick Metric Overview -->
        <div class="kin-run-stat-grid">
          <div class="kin-stat-item">
            <span class="kin-stat-key">PITCH PEAK / MIN</span>
            <span class="kin-stat-val">${(run.summary.maxPitch >= 0 ? '+' : '') + run.summary.maxPitch.toFixed(1)}° / ${(run.summary.minPitch >= 0 ? '+' : '') + run.summary.minPitch.toFixed(1)}°</span>
          </div>
          <div class="kin-stat-item">
            <span class="kin-stat-key">ROLL PEAK / MIN</span>
            <span class="kin-stat-val">${(run.summary.maxRoll >= 0 ? '+' : '') + run.summary.maxRoll.toFixed(1)}° / ${(run.summary.minRoll >= 0 ? '+' : '') + run.summary.minRoll.toFixed(1)}°</span>
          </div>
          <div class="kin-stat-item">
            <span class="kin-stat-key">AX VERT / AZ LONG</span>
            <span class="kin-stat-val">${(run.summary.maxAx >= 0 ? '+' : '') + run.summary.maxAx.toFixed(2)}g / ${(run.summary.minAz >= 0 ? '+' : '') + run.summary.minAz.toFixed(2)}g</span>
          </div>
          <div class="kin-stat-item">
            <span class="kin-stat-key">PEAK SPEED</span>
            <span class="kin-stat-val">${run.summary.maxSpeed.toFixed(1)} km/h</span>
          </div>
        </div>

        <!-- Actions Row: Modal Table Trigger, CSV Export, Delete Authority -->
        <div class="kin-run-actions-row">
          <button class="btn-toggle-table" onclick="openKinRunModal('${run.id}')" title="Open full tabular log dialog">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
              <line x1="3" y1="9" x2="21" y2="9"></line>
              <line x1="3" y1="15" x2="21" y2="15"></line>
              <line x1="9" y1="3" x2="9" y2="21"></line>
            </svg>
            <span>Open Record Table (${run.samples.length} rows)</span>
          </button>

          <div class="run-action-btns">
            <button class="btn-run-action" onclick="exportSingleRunCSV('${run.id}')" title="Download CSV for this run">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                <polyline points="7 10 12 15 17 10"></polyline>
                <line x1="12" y1="15" x2="12" y2="3"></line>
              </svg>
              <span>CSV</span>
            </button>
            <button class="btn-run-action danger" onclick="deleteKinematicsRun('${run.id}')" title="Delete this test run">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6"></polyline>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
              </svg>
              <span>Delete</span>
            </button>
          </div>
        </div>
      </div>
    `;
  }).join('');

  // Update Pagination Controls
  if (paginationBar) {
    paginationBar.style.display = totalRuns > kinRunsPerPage ? 'flex' : 'none';
    if (paginationInfo) {
      paginationInfo.textContent = `Page ${kinCurrentPage} of ${totalPages} (${totalRuns} runs)`;
    }
    if (btnPrev) btnPrev.disabled = (kinCurrentPage <= 1);
    if (btnNext) btnNext.disabled = (kinCurrentPage >= totalPages);
  }
}

function openKinRunModal(runId) {
  const run = kinRunsHistory.find(r => r.id === runId);
  if (!run) return;

  activeModalRunId = runId;
  const modal = document.getElementById('kinTableModal');
  const subEl = document.getElementById('kinModalSub');
  const titleEl = document.getElementById('kinModalTitle');
  const statBar = document.getElementById('kinModalStatGrid');
  const tbody = document.getElementById('kinModalTableBody');
  const noteEl = document.getElementById('kinModalSampleCountNote');

  const d = new Date(run.startTime);
  const dateFormatted = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const timeFormatted = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  if (subEl) subEl.textContent = `${escapeHtml(run.maneuverTitle || run.maneuver).toUpperCase()} • ${dateFormatted} at ${timeFormatted}`;
  if (titleEl) titleEl.textContent = `${run.maneuverTitle || run.maneuver} Telemetry Run (${run.durationSec}s)`;
  if (noteEl) noteEl.textContent = `Total samples: ${run.samples.length} rows | Duration: ${run.durationSec}s`;

  if (statBar) {
    statBar.innerHTML = `
      <div class="kin-stat-item">
        <span class="kin-stat-key">PITCH PEAK / MIN</span>
        <span class="kin-stat-val">${(run.summary.maxPitch >= 0 ? '+' : '') + run.summary.maxPitch.toFixed(1)}° / ${(run.summary.minPitch >= 0 ? '+' : '') + run.summary.minPitch.toFixed(1)}°</span>
      </div>
      <div class="kin-stat-item">
        <span class="kin-stat-key">ROLL PEAK / MIN</span>
        <span class="kin-stat-val">${(run.summary.maxRoll >= 0 ? '+' : '') + run.summary.maxRoll.toFixed(1)}° / ${(run.summary.minRoll >= 0 ? '+' : '') + run.summary.minRoll.toFixed(1)}°</span>
      </div>
      <div class="kin-stat-item">
        <span class="kin-stat-key">AX VERT / AZ LONG</span>
        <span class="kin-stat-val">${(run.summary.maxAx >= 0 ? '+' : '') + run.summary.maxAx.toFixed(2)}g / ${(run.summary.minAz >= 0 ? '+' : '') + run.summary.minAz.toFixed(2)}g</span>
      </div>
      <div class="kin-stat-item">
        <span class="kin-stat-key">PEAK SPEED</span>
        <span class="kin-stat-val">${run.summary.maxSpeed.toFixed(1)} km/h</span>
      </div>
    `;
  }

  if (tbody) {
    tbody.innerHTML = run.samples.map(s => `
      <tr>
        <td>${s.num}</td>
        <td>+${s.relTimeSec.toFixed(2)}s</td>
        <td>${escapeHtml(s.timeStr)}</td>
        <td>${(s.ax >= 0 ? '+' : '') + s.ax.toFixed(2)}g</td>
        <td>${(s.ay >= 0 ? '+' : '') + s.ay.toFixed(2)}g</td>
        <td>${(s.az >= 0 ? '+' : '') + s.az.toFixed(2)}g</td>
        <td>${(s.pitch >= 0 ? '+' : '') + s.pitch.toFixed(1)}°</td>
        <td>${(s.roll >= 0 ? '+' : '') + s.roll.toFixed(1)}°</td>
        <td>${s.tilt.toFixed(1)}°</td>
        <td>${s.speed.toFixed(1)} km/h</td>
        <td><span class="tag-pill ${escapeHtml(s.tagCls || 'tag-steady')}">${escapeHtml(s.tagText || 'STEADY')}</span></td>
      </tr>
    `).join('');
  }

  if (modal) {
    modal.classList.remove('hidden');
  }
}

function closeKinRunModal() {
  const modal = document.getElementById('kinTableModal');
  if (modal) modal.classList.add('hidden');
  activeModalRunId = null;
}

function deleteKinematicsRun(runId) {
  if (!confirm("Are you sure you want to delete this recorded test run?")) return;
  kinRunsHistory = kinRunsHistory.filter(r => r.id !== runId);
  saveKinematicsRunsToStorage();
  if (activeModalRunId === runId) {
    closeKinRunModal();
  }
  renderKinematicsRuns();
}

function exportSingleRunCSV(runId) {
  const run = kinRunsHistory.find(r => r.id === runId);
  if (!run || !run.samples || run.samples.length === 0) {
    alert("No data available to export for this run.");
    return;
  }

  const csvRows = [];
  csvRows.push(['SerialNo', 'RelTime_Sec', 'Timestamp', 'Ax_Vert_g', 'Ay_Lat_g', 'Az_Long_g', 'Pitch_deg', 'Roll_deg', 'Tilt_deg', 'Speed_kmh', 'Dynamic_State'].join(','));

  run.samples.forEach(s => {
    csvRows.push([
      s.num,
      s.relTimeSec.toFixed(2),
      `"${s.timeStr}"`,
      s.ax.toFixed(2),
      s.ay.toFixed(2),
      s.az.toFixed(2),
      s.pitch.toFixed(1),
      s.roll.toFixed(1),
      s.tilt.toFixed(1),
      s.speed.toFixed(1),
      `"${s.tagText || 'STEADY'}"`
    ].join(','));
  });

  const blob = new Blob([csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `chalok_${run.maneuver}_${run.id}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function exportAllKinematicsCSV() {
  if (kinRunsHistory.length === 0) {
    alert("No recorded kinematic runs available to export.");
    return;
  }

  const csvRows = [];
  csvRows.push(['Run_ID', 'Maneuver', 'Run_Date', 'SerialNo', 'RelTime_Sec', 'Timestamp', 'Ax_Vert_g', 'Ay_Lat_g', 'Az_Long_g', 'Pitch_deg', 'Roll_deg', 'Tilt_deg', 'Speed_kmh', 'Dynamic_State'].join(','));

  kinRunsHistory.forEach(run => {
    const dStr = new Date(run.startTime).toISOString();
    run.samples.forEach(s => {
      csvRows.push([
        `"${run.id}"`,
        `"${run.maneuver}"`,
        `"${dStr}"`,
        s.num,
        s.relTimeSec.toFixed(2),
        `"${s.timeStr}"`,
        s.ax.toFixed(2),
        s.ay.toFixed(2),
        s.az.toFixed(2),
        s.pitch.toFixed(1),
        s.roll.toFixed(1),
        s.tilt.toFixed(1),
        s.speed.toFixed(1),
        `"${s.tagText || 'STEADY'}"`
      ].join(','));
    });
  });

  const blob = new Blob([csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `chalok_kinematics_dataset_${Date.now()}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function clearAllKinematicsRuns() {
  if (kinRunsHistory.length === 0) {
    alert("No runs to clear.");
    return;
  }
  if (!confirm("Are you sure you want to permanently delete ALL recorded test runs? This cannot be undone.")) return;
  kinRunsHistory = [];
  closeKinRunModal();
  saveKinematicsRunsToStorage();
  kinCurrentPage = 1;
  renderKinematicsRuns();
}

// Expose action handlers on window for HTML onclick compatibility
window.openKinRunModal = openKinRunModal;
window.closeKinRunModal = closeKinRunModal;
window.exportSingleRunCSV = exportSingleRunCSV;
window.deleteKinematicsRun = deleteKinematicsRun;

function setupKinematicsEventListeners() {
  // Maneuver pill clicks on desktop
  document.querySelectorAll('.kin-cat-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const m = btn.getAttribute('data-maneuver');
      selectKinematicsManeuver(m);
    });
  });

  // Maneuver dropdown change on mobile
  const mobileSelect = document.getElementById('kinMobileSelect');
  if (mobileSelect) {
    mobileSelect.addEventListener('change', (e) => {
      selectKinematicsManeuver(e.target.value);
    });
  }

  // Toggle record button
  const btnToggleRecord = document.getElementById('btnToggleKinRecord');
  if (btnToggleRecord) {
    btnToggleRecord.addEventListener('click', () => {
      if (isKinRecording) {
        stopKinematicsRecording();
      } else {
        startKinematicsRecording();
      }
    });
  }

  // Filter buttons: Current vs All
  const btnFilterCurrent = document.getElementById('btnFilterCurrentManeuver');
  const btnFilterAll = document.getElementById('btnFilterAllManeuvers');

  if (btnFilterCurrent) {
    btnFilterCurrent.addEventListener('click', () => {
      kinRunsFilter = 'current';
      btnFilterCurrent.classList.add('active');
      if (btnFilterAll) btnFilterAll.classList.remove('active');
      try { localStorage.setItem('chalok_kin_filter', 'current'); } catch (e) {}
      kinCurrentPage = 1;
      renderKinematicsRuns();
    });
  }

  if (btnFilterAll) {
    btnFilterAll.addEventListener('click', () => {
      kinRunsFilter = 'all';
      btnFilterAll.classList.add('active');
      if (btnFilterCurrent) btnFilterCurrent.classList.remove('active');
      try { localStorage.setItem('chalok_kin_filter', 'all'); } catch (e) {}
      kinCurrentPage = 1;
      renderKinematicsRuns();
    });
  }

  // Sorting filter dropdown: Latest vs Oldest
  const sortSelect = document.getElementById('kinSortSelect');
  if (sortSelect) {
    sortSelect.addEventListener('change', (e) => {
      kinRunsSortOrder = e.target.value;
      kinCurrentPage = 1;
      renderKinematicsRuns();
    });
  }

  // Pagination buttons: Previous & Next
  const btnPrev = document.getElementById('btnKinPrevPage');
  const btnNext = document.getElementById('btnKinNextPage');

  if (btnPrev) {
    btnPrev.addEventListener('click', () => {
      if (kinCurrentPage > 1) {
        kinCurrentPage--;
        renderKinematicsRuns();
      }
    });
  }

  if (btnNext) {
    btnNext.addEventListener('click', () => {
      kinCurrentPage++;
      renderKinematicsRuns();
    });
  }

  // Modal Table close handlers
  const btnCloseModal = document.getElementById('btnCloseKinTableModal');
  const btnDismissModal = document.getElementById('btnDismissKinTableModal');
  const modalBackdrop = document.getElementById('kinTableModalBackdrop');
  const btnModalExportCSV = document.getElementById('btnModalExportCSV');

  if (btnCloseModal) btnCloseModal.addEventListener('click', closeKinRunModal);
  if (btnDismissModal) btnDismissModal.addEventListener('click', closeKinRunModal);
  if (modalBackdrop) modalBackdrop.addEventListener('click', closeKinRunModal);

  if (btnModalExportCSV) {
    btnModalExportCSV.addEventListener('click', () => {
      if (activeModalRunId) exportSingleRunCSV(activeModalRunId);
    });
  }

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && activeModalRunId) {
      closeKinRunModal();
    }
  });

  // Global action buttons: Export all & Clear all
  const btnExportAll = document.getElementById('btnExportAllKinematics');
  const btnClearAll = document.getElementById('btnClearAllKinematics');

  if (btnExportAll) {
    btnExportAll.addEventListener('click', exportAllKinematicsCSV);
  }
  if (btnClearAll) {
    btnClearAll.addEventListener('click', clearAllKinematicsRuns);
  }
}

function initKinematicsLab() {
  loadKinematicsRunsFromStorage();

  let savedManeuver = 'speed_breaker';
  let savedFilter = 'current';
  try {
    savedManeuver = localStorage.getItem('chalok_kin_active_maneuver') || 'speed_breaker';
    savedFilter = localStorage.getItem('chalok_kin_filter') || 'current';
  } catch (e) {}

  kinRunsFilter = savedFilter;
  const btnFilterCurrent = document.getElementById('btnFilterCurrentManeuver');
  const btnFilterAll = document.getElementById('btnFilterAllManeuvers');
  if (btnFilterCurrent && btnFilterAll) {
    btnFilterCurrent.classList.toggle('active', kinRunsFilter === 'current');
    btnFilterAll.classList.toggle('active', kinRunsFilter === 'all');
  }

  selectKinematicsManeuver(savedManeuver);
  setupKinematicsEventListeners();
  updateKinematicsStandbyStatus();
  renderKinematicsRuns();
}

// =============================================================================
// APP INITIALIZATION
// =============================================================================
document.addEventListener('DOMContentLoaded', () => {
  initMainMap();
  setupFirebaseListeners();
  setupModeSwitcher();
  setupAdminRecordingControls();
  setupClearHistoryButton();
  setupTripModalClose();
  setupNavigation();
  initKinematicsLab();
});