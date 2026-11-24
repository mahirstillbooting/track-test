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
  db.ref('tracker/active').on('value', (snap) => {
    isSharingActive = (snap.val() === true);
    
    // Update Floating Ride Pill
    const sharingPill = document.getElementById('rideSharingBadge');
    const sharingLabel = document.getElementById('rideSharingLabel');
    if (isSharingActive) {
      sharingPill.className = 'sharing-pill active';
      sharingLabel.textContent = 'SHARING ACTIVE';
    } else {
      sharingPill.className = 'sharing-pill stopped';
      sharingLabel.textContent = 'STANDBY';
    }

    // Refresh Admin Journey Recording State & Last Recorded Display
    updateAdminRecordingUI();
    updateLastRecordedDisplay();
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
    document.getElementById('gpsFixStatus').textContent = sats >= 4 ? '3D GPS Fix' : 'Searching';
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
          pill.textContent = 'A-GPS';
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
function updateAdminRecordingUI() {
  const adminRecordingBar = document.getElementById('adminRecordingBar');
  const warningBox = document.getElementById('adminSharingWarning');
  const readyBox = document.getElementById('adminReadyBox');
  const recordingBox = document.getElementById('adminRecordingBox');

  // Only visible when currentMode === 'admin'
  if (currentMode !== 'admin') {
    adminRecordingBar.classList.add('hidden');
    return;
  }
  adminRecordingBar.classList.remove('hidden');

  // Validation: Is device actively sharing location?
  if (!isSharingActive) {
    warningBox.classList.remove('hidden');
    readyBox.classList.add('hidden');
    recordingBox.classList.add('hidden');
    
    if (isRecordingTrip) {
      recordingBox.classList.remove('hidden');
    }
  } else {
    warningBox.classList.add('hidden');
    if (isRecordingTrip) {
      readyBox.classList.add('hidden');
      recordingBox.classList.remove('hidden');
    } else {
      readyBox.classList.remove('hidden');
      recordingBox.classList.add('hidden');
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

  // Record point if moved >= 2.2 meters (ignores stationary jitter knots)
  if (distMeters >= 2.2) {
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
    const durationSeconds = Math.floor((Date.now() - tripSession.startTime) / 1000);
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

    // Save to Firebase RTDB under /history
    db.ref('history').push(tripRecord).then(() => {
      alert(`Journey successfully saved!\nTotal Distance: ${distanceKm} km\nDuration: ${formatDuration(durationSeconds)}`);
      
      // Clean up local recording state
      isRecordingTrip = false;
      tripSession.points = [];
      tripSession.totalDistMeters = 0;
      tripSession.lastRecordedCoord = null;
      if (activeRecordingPolyline) {
        map.removeLayer(activeRecordingPolyline);
        activeRecordingPolyline = null;
      }
      timerEl.textContent = "00:00:00";
      updateAdminRecordingUI();

      // Automatically switch to Trips History view
      switchView('viewTrips');
    }).catch(err => {
      console.error("Error saving trip:", err);
      alert("Failed to save trip to database: " + err.message);
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
      if (activeRecordingPolyline) {
        map.removeLayer(activeRecordingPolyline);
        activeRecordingPolyline = null;
      }
      timerEl.textContent = "00:00:00";
      updateAdminRecordingUI();
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
function renderTripsList(historyData) {
  const container = document.getElementById('tripsList');
  container.innerHTML = '';

  const keys = Object.keys(historyData || {});
  if (keys.length === 0) {
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

  // Active orders section (if currently recording)
  if (isRecordingTrip) {
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
        <button class="btn-view-route" data-key="${key}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"></polygon>
          </svg>
          <span>View Route</span>
        </button>
      </div>
    `;

    card.querySelector('.btn-view-route').addEventListener('click', () => {
      openTripModal(key, trip);
    });

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
  const btnMobile = document.getElementById('btnMobileModeToggle');
  const mobileLabel = document.getElementById('mobileModeLabel');
  const mobileIconWrap = document.getElementById('mobileModeIconWrap');
  const badgePulse = document.getElementById('mobileModeBadgePulse');

  if (btnRider && btnAdmin) {
    btnRider.classList.toggle('active', mode === 'rider');
    btnAdmin.classList.toggle('active', mode === 'admin');
  }

  if (btnMobile) {
    btnMobile.classList.toggle('active', mode === 'admin');
  }

  if (badgePulse) {
    badgePulse.classList.toggle('hidden', mode !== 'admin');
  }

  if (mobileLabel) {
    mobileLabel.textContent = mode === 'admin' ? 'Admin' : 'Rider';
  }

  if (mobileIconWrap) {
    mobileIconWrap.classList.remove('flip-effect');
    void mobileIconWrap.offsetWidth; // trigger reflow for smooth animation
    mobileIconWrap.classList.add('flip-effect');

    if (mode === 'admin') {
      mobileIconWrap.innerHTML = `
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
          <path d="m9 12 2 2 4-4"></path>
        </svg>
      `;
    } else {
      mobileIconWrap.innerHTML = `
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
          <circle cx="12" cy="7" r="4"></circle>
        </svg>
      `;
    }
  }

  updateAdminRecordingUI();

  if (triggeredByUser) {
    showModeSwitchToast(mode);
  }
}

function setupModeSwitcher() {
  const btnRider = document.getElementById('btnRiderMode');
  const btnAdmin = document.getElementById('btnAdminMode');
  const btnMobile = document.getElementById('btnMobileModeToggle');

  if (btnRider) {
    btnRider.addEventListener('click', () => setAppMode('rider', true));
  }

  if (btnAdmin) {
    btnAdmin.addEventListener('click', () => setAppMode('admin', true));
  }

  if (btnMobile) {
    btnMobile.addEventListener('click', () => {
      setAppMode(currentMode === 'rider' ? 'admin' : 'rider', true);
    });
  }
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
});