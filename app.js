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

// Telemetry & Device Packet Clock
let lastPacketWallTime = null;
let lastPacketDeviceTs = null;
let lastPacketDataString = '';

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
function initMainMap() {
  const defaultLat = 23.7186;
  const defaultLng = 90.3837;

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

  // Custom DivIcon for Vehicle Marker (Using GM Accent / No Green)
  const trackerIcon = L.divIcon({
    className: 'custom-tracker-marker',
    html: `
      <div class="marker-pulse"></div>
      <div class="marker-core">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polygon points="12 2 19 21 12 17 5 21 12 2"></polygon>
        </svg>
      </div>
    `,
    iconSize: [38, 38],
    iconAnchor: [19, 19]
  });

  trackerMarker = L.marker([defaultLat, defaultLng], { icon: trackerIcon }).addTo(map);
  trackerMarker.bindPopup('<b>CHALOK Vehicle</b><br>Standby position');

  // Recenter button listener
  document.getElementById('btnRecenter').addEventListener('click', () => {
    if (lastCoords.lat !== null && lastCoords.lng !== null) {
      map.flyTo([lastCoords.lat, lastCoords.lng], 17, { duration: 0.8 });
    }
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
// SMOOTH MARKER ANIMATION
// =============================================================================
function animateMarker(newLat, newLng) {
  if (lastCoords.lat === null || lastCoords.lng === null) {
    lastCoords = { lat: newLat, lng: newLng };
    trackerMarker.setLatLng([newLat, newLng]);
    if (!hasReceivedFirstFix) {
      map.setView([newLat, newLng], 16);
      hasReceivedFirstFix = true;
    }
    return;
  }

  const dist = calcDistanceMeters(lastCoords.lat, lastCoords.lng, newLat, newLng);
  if (dist < 2.0) return; // Keep marker rock solid if under 2m drift

  const startLat = lastCoords.lat;
  const startLng = lastCoords.lng;
  const startTime = performance.now();
  const duration = 800; // ms

  if (animationFrameId) cancelAnimationFrame(animationFrameId);

  function step(time) {
    const progress = Math.min((time - startTime) / duration, 1);
    const ease = 1 - Math.pow(1 - progress, 2); // Quad ease-out

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

  if (!hasReceivedFirstFix) {
    map.setView([newLat, newLng], 16);
    hasReceivedFirstFix = true;
  }
}

// =============================================================================
// DEVICE RECORDED TIMESTAMP & AGE TICKER (1-Second Engine)
// =============================================================================
function updateLastRecordedDisplay() {
  const pillText = document.getElementById('lastRecordedText');
  const telemText = document.getElementById('telemLastRec');

  if (!lastPacketWallTime) {
    if (pillText) pillText.textContent = 'Waiting for GPS...';
    if (telemText) telemText.textContent = 'No packets received';
    return;
  }

  const elapsedSec = Math.floor((Date.now() - lastPacketWallTime) / 1000);
  let relativeAgeStr = '';

  if (elapsedSec < 4) {
    relativeAgeStr = 'Just now';
  } else if (elapsedSec < 60) {
    relativeAgeStr = `${elapsedSec}s ago`;
  } else if (elapsedSec < 3600) {
    const m = Math.floor(elapsedSec / 60);
    relativeAgeStr = `${m}m ago ${!isSharingActive ? '(Standby)' : ''}`;
  } else {
    const h = Math.floor(elapsedSec / 3600);
    relativeAgeStr = `>${h}h ago (Offline)`;
  }

  // Determine actual recorded clock time
  let clockTimeStr = '';
  if (lastPacketDeviceTs && lastPacketDeviceTs > 1577836800000) {
    // GPS Real-world UTC epoch
    const d = new Date(lastPacketDeviceTs);
    clockTimeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } else {
    // Wall time receipt of device packet
    const d = new Date(lastPacketWallTime);
    clockTimeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  const fullDisplay = `Rec: ${clockTimeStr} (${relativeAgeStr})`;
  if (pillText) pillText.textContent = fullDisplay;
  if (telemText) telemText.textContent = fullDisplay;
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

    // Refresh Admin Journey Recording State
    updateAdminRecordingUI();
  });

  // C. Live Telemetry & GPS Coordinates (tracker/current)
  db.ref('tracker/current').on('value', (snap) => {
    const data = snap.val();
    if (!data) return;

    const dataString = JSON.stringify(data);
    if (dataString !== lastPacketDataString) {
      lastPacketDataString = dataString;
      lastPacketWallTime = Date.now();
      lastPacketDeviceTs = data.timestamp || null;
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
      document.getElementById('telemLat').textContent = lat.toFixed(6);
      document.getElementById('telemLng').textContent = lng.toFixed(6);

      // Animate Marker Smoothly
      animateMarker(lat, lng);

      // Calculate speed dynamically from coordinates movement
      updateCalculatedSpeed(lat, lng);

      // If Admin has started recording journey, append point
      if (isRecordingTrip) {
        handleTripPointRecording(lat, lng);
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

  // Record point if moved >= 2.0 meters
  if (distMeters >= 2.0) {
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
  const latLngs = tripSession.points.map(p => [p.lat, p.lng]);
  if (!activeRecordingPolyline) {
    activeRecordingPolyline = L.polyline(latLngs, {
      color: '#a8c7fa', // Material accent
      weight: 5,
      opacity: 0.95,
      lineCap: 'round',
      lineJoin: 'round'
    }).addTo(map);
  } else {
    activeRecordingPolyline.setLatLngs(latLngs);
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

  // Reverse to show latest first
  keys.reverse().forEach(key => {
    const trip = historyData[key];
    const dist = trip.distanceKm !== undefined ? trip.distanceKm : (trip.totalDistanceKm || 0.0);
    const duration = trip.durationFormatted || (trip.durationSeconds ? formatDuration(trip.durationSeconds) : '--');
    const ptsCount = trip.pointsCount || (trip.points ? Object.keys(trip.points).length : 0);
    const title = trip.title || trip.formattedDate || `Recorded Journey`;

    const startLat = trip.startCoords?.lat ? trip.startCoords.lat.toFixed(4) : '--';
    const startLng = trip.startCoords?.lng ? trip.startCoords.lng.toFixed(4) : '--';
    const endLat = trip.endCoords?.lat ? trip.endCoords.lat.toFixed(4) : '--';
    const endLng = trip.endCoords?.lng ? trip.endCoords.lng.toFixed(4) : '--';

    const card = document.createElement('div');
    card.className = 'uber-trip-card';
    card.innerHTML = `
      <div class="trip-card-header">
        <div class="trip-title-group">
          <h4>${title}</h4>
          <span class="trip-date">${trip.formattedDate || 'Completed Trip'}</span>
        </div>
        <div class="trip-badge-distance">${Number(dist).toFixed(2)} km</div>
      </div>

      <div class="trip-route-timeline">
        <div class="timeline-point">
          <span class="point-dot start"></span>
          <span class="point-label">Origin</span>
          <span class="point-value">${startLat}, ${startLng}</span>
        </div>
        <div class="timeline-point">
          <span class="point-dot end"></span>
          <span class="point-label">Destination</span>
          <span class="point-value">${endLat}, ${endLng}</span>
        </div>
      </div>

      <div class="trip-card-footer">
        <div class="trip-meta-tags">
          <span>Duration: <b>${duration}</b></span>
          <span>Points: <b>${ptsCount}</b></span>
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
// FOCUSED TRIP MODAL (Fraction Rectangle Bounding Box Viewer)
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

  const m = getModalMap();
  setTimeout(() => {
    m.invalidateSize();

    // Clean up previous layers
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
      modalPolyline = L.polyline(coords, {
        color: '#a8c7fa', // Material accent
        weight: 5,
        opacity: 0.95,
        lineCap: 'round',
        lineJoin: 'round'
      }).addTo(m);

      // Start pin (accent circle)
      modalStartMarker = L.circleMarker(coords[0], {
        radius: 7,
        color: '#ffffff',
        fillColor: '#a8c7fa',
        fillOpacity: 1,
        weight: 3
      }).addTo(m).bindPopup('<b>Trip Origin</b>');

      // End pin (sparkle coral circle)
      modalEndMarker = L.circleMarker(coords[coords.length - 1], {
        radius: 7,
        color: '#ffffff',
        fillColor: '#d96570',
        fillOpacity: 1,
        weight: 3
      }).addTo(m).bindPopup('<b>Trip Destination</b>');

      // Strictly fit to the fraction rectangle bounding box covered by the device!
      m.fitBounds(modalPolyline.getBounds(), {
        padding: [45, 45],
        maxZoom: 18
      });
    }
  }, 200);
}

function setupTripModalClose() {
  const modal = document.getElementById('tripModal');
  const btnClose = document.getElementById('btnCloseModal');
  const backdrop = modal.querySelector('.modal-backdrop');

  btnClose.addEventListener('click', () => modal.classList.add('hidden'));
  backdrop.addEventListener('click', () => modal.classList.add('hidden'));
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
// RIDER VS ADMIN MODE SWITCHER
// =============================================================================
function setupModeSwitcher() {
  const btnRider = document.getElementById('btnRiderMode');
  const btnAdmin = document.getElementById('btnAdminMode');

  btnRider.addEventListener('click', () => {
    currentMode = 'rider';
    btnRider.classList.add('active');
    btnAdmin.classList.remove('active');
    updateAdminRecordingUI();
  });

  btnAdmin.addEventListener('click', () => {
    currentMode = 'admin';
    btnAdmin.classList.add('active');
    btnRider.classList.remove('active');
    updateAdminRecordingUI();
  });
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