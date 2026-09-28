// ESP32 Live Tracker Client Application

// 1. Firebase Configuration
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

// Initialize Firebase Realtime Database
firebase.initializeApp(firebaseConfig);
const db = firebase.database();

// 2. State Management
let map = null;
let trackerMarker = null;
let journeyPolyline = null;
let hasReceivedFirstFix = false;
let lastCoords = { lat: null, lng: null };
let animationFrameId = null;
let currentMode = 'passenger';

// 3. Initialize Leaflet Map
function initMap() {
  // Default coordinates (Dhaka fallback)
  const defaultLat = 23.8103;
  const defaultLng = 90.4125;

  map = L.map('map', {
    zoomControl: true,
    attributionControl: true
  }).setView([defaultLat, defaultLng], 15);

  // Esri World Street Map Tile Layer (Open, reliable, no API key required)
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
    attribution: 'Tiles &copy; Esri &mdash; Source: Esri, DeLorme, NAVTEQ, USGS, Intermap, iPC, NRCAN, Esri Japan, METI, Esri China, TomTom'
  }).addTo(map);

  // Custom DivIcon for Tracker Marker
  const trackerIcon = L.divIcon({
    className: 'custom-tracker-marker',
    html: `
      <div class="marker-pulse"></div>
      <div class="marker-core">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <circle cx="12" cy="12" r="7"></circle>
          <path d="M12 2v3M12 19v3M2 12h3M19 12h3"></path>
        </svg>
      </div>
    `,
    iconSize: [36, 36],
    iconAnchor: [18, 18]
  });

  // Create Marker
  trackerMarker = L.marker([defaultLat, defaultLng], { icon: trackerIcon }).addTo(map);
  trackerMarker.bindPopup('<b>ESP32 Tracker</b><br>Initial position');
}

// 4. Smooth Marker Movement
function updateMarkerPosition(newLat, newLng) {
  // First time position received
  if (lastCoords.lat === null || lastCoords.lng === null) {
    lastCoords = { lat: newLat, lng: newLng };
    trackerMarker.setLatLng([newLat, newLng]);
    if (!hasReceivedFirstFix) {
      map.setView([newLat, newLng], 16);
      hasReceivedFirstFix = true;
    }
    return;
  }

  // Calculate distance moved in meters using Haversine formula
  const R = 6371000; // Earth radius in meters
  const dLat = (newLat - lastCoords.lat) * Math.PI / 180;
  const dLng = (newLng - lastCoords.lng) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lastCoords.lat * Math.PI / 180) * Math.cos(newLat * Math.PI / 180) *
            Math.sin(dLng/2) * Math.sin(dLng/2);
  const distMeters = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  // If change is under 3 meters (GPS stationary drift/noise), keep marker completely still
  if (distMeters < 3.0) {
    return;
  }

  // Smooth position interpolation over 800ms
  const startLat = lastCoords.lat;
  const startLng = lastCoords.lng;
  const startTime = performance.now();
  const duration = 800; // milliseconds

  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
  }

  function step(currentTime) {
    const elapsed = currentTime - startTime;
    const progress = Math.min(elapsed / duration, 1);
    
    // Ease-out quad curve for natural decelerating motion
    const ease = 1 - (1 - progress) * (1 - progress);

    const interpolatedLat = startLat + (newLat - startLat) * ease;
    const interpolatedLng = startLng + (newLng - startLng) * ease;

    trackerMarker.setLatLng([interpolatedLat, interpolatedLng]);

    if (progress < 1) {
      animationFrameId = requestAnimationFrame(step);
    } else {
      lastCoords = { lat: newLat, lng: newLng };
    }
  }

  animationFrameId = requestAnimationFrame(step);

  // Automatically center map on first valid position fix
  if (!hasReceivedFirstFix) {
    map.setView([newLat, newLng], 16);
    hasReceivedFirstFix = true;
  }
}

// 5. Firebase Realtime Listeners
function setupFirebaseListeners() {
  // A. Connection Status Listener (.info/connected)
  db.ref('.info/connected').on('value', (snap) => {
    const badge = document.getElementById('connectionStatus');
    const label = badge.querySelector('.status-label');

    if (snap.val() === true) {
      badge.className = 'connection-badge connected';
      label.textContent = 'Connected';
    } else {
      badge.className = 'connection-badge disconnected';
      label.textContent = 'Disconnected';
    }
  });

  let previousActiveState = null;

  // B. Tracker Sharing Status Listener (tracker/active)
  db.ref('tracker/active').on('value', (snap) => {
    const isActive = snap.val() === true;
    const indicator = document.getElementById('sharingStatus');
    const statusText = document.getElementById('sharingStatusText');

    // Auto-reload webpage when ESP32 starts a new active tracking session
    if (previousActiveState === false && isActive === true) {
      console.log("Tracker activated! Auto-reloading page...");
      window.location.reload();
      return;
    }
    previousActiveState = isActive;

    if (isActive) {
      indicator.className = 'status-indicator active';
      statusText.textContent = 'ACTIVE';
    } else {
      indicator.className = 'status-indicator stopped';
      statusText.textContent = 'STOPPED';
    }
  });

  // C. Current Location Listener (tracker/current)
  db.ref('tracker/current').on('value', (snap) => {
    const data = snap.val();
    if (!data) return;

    const lat = parseFloat(data.lat);
    const lng = parseFloat(data.lng);
    const speed = data.speedKmh !== undefined ? data.speedKmh : (data.speed || 0);
    const sats = data.satellites || 0;
    const hdop = data.hdop !== undefined ? data.hdop : 0;
    const ts = data.timestamp || 0;

    // Update UI Metric Cards
    document.getElementById('speedVal').textContent = Number(speed).toFixed(1);
    document.getElementById('satsVal').textContent = sats;
    document.getElementById('hdopVal').textContent = Number(hdop).toFixed(1);

    // Format last update timestamp safely (Fixes 1970 date bug for ESP32 millis() & test data)
    let timeString = '';
    const now = new Date();
    const isEpochMs = ts > 1577836800000;  // > Jan 1, 2020 in ms
    const isEpochSec = ts > 1577836800 && ts < 1577836800000; // > Jan 1, 2020 in sec

    if (isEpochMs || isEpochSec) {
      const d = new Date(isEpochMs ? ts : ts * 1000);
      timeString = d.toLocaleTimeString() + ' (' + d.toLocaleDateString() + ')';
    } else {
      // For ESP32 millis() or test data, display local receipt time
      timeString = now.toLocaleTimeString() + ' (Just now)';
    }
    document.getElementById('lastUpdateVal').textContent = timeString;

    // Smoothly animate marker position on map
    if (!isNaN(lat) && !isNaN(lng)) {
      updateMarkerPosition(lat, lng);
    }
  });
}

// 6. Mode Switcher Setup (Passenger / Admin)
function setupModeSwitcher() {
  const btnPassenger = document.getElementById('btnPassenger');
  const btnAdmin = document.getElementById('btnAdmin');
  const adminPanel = document.getElementById('adminPanel');

  btnPassenger.addEventListener('click', () => {
    currentMode = 'passenger';
    btnPassenger.classList.add('active');
    btnAdmin.classList.remove('active');
    adminPanel.classList.add('hidden');
    if (map) map.invalidateSize();
  });

  btnAdmin.addEventListener('click', () => {
    currentMode = 'admin';
    btnAdmin.classList.add('active');
    btnPassenger.classList.remove('active');
    adminPanel.classList.remove('hidden');
    if (map) map.invalidateSize();
  });
}

// 7. Journey Controls (Admin Mode)
function setupJourneyControls() {
  const btnShowJourney = document.getElementById('btnShowJourney');
  const btnArchiveJourney = document.getElementById('btnArchiveJourney');
  const btnClearJourney = document.getElementById('btnClearJourney');
  const historySelect = document.getElementById('historySelect');
  const journeyStatus = document.getElementById('journeyStatus');

  let historyCache = {}; // Cache of loaded history entries

  // Helper to render polyline from point array
  function drawJourneyPolyline(coords, label) {
    if (journeyPolyline) {
      map.removeLayer(journeyPolyline);
    }

    journeyPolyline = L.polyline(coords, {
      color: '#3b82f6',
      weight: 4,
      opacity: 0.85,
      lineJoin: 'round',
      lineCap: 'round'
    }).addTo(map);

    map.fitBounds(journeyPolyline.getBounds(), { padding: [40, 40] });
    journeyStatus.textContent = label;
  }

  // A. Show Current Active Journey
  btnShowJourney.addEventListener('click', () => {
    journeyStatus.textContent = 'Fetching current journey...';

    db.ref('tracker/journey').once('value').then((snap) => {
      let val = snap.val();
      if (!val) {
        return db.ref('journey').once('value').then(rootSnap => rootSnap.val());
      }
      return val;
    }).then((val) => {
      if (!val) {
        journeyStatus.textContent = 'No current journey data in DB.';
        return;
      }

      const rawPoints = [];
      if (Array.isArray(val)) {
        val.forEach(item => { if (item) rawPoints.push(item); });
      } else if (typeof val === 'object') {
        Object.keys(val).forEach(key => { if (val[key]) rawPoints.push(val[key]); });
      }

      rawPoints.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
      const coords = rawPoints
        .filter(p => !isNaN(parseFloat(p.lat)) && !isNaN(parseFloat(p.lng)))
        .map(p => [parseFloat(p.lat), parseFloat(p.lng)]);

      if (coords.length === 0) {
        journeyStatus.textContent = 'No valid coordinates in current journey.';
        return;
      }

      drawJourneyPolyline(coords, `Displaying ${coords.length} active journey point(s)`);
    }).catch((err) => {
      console.error('Error fetching current journey:', err);
      journeyStatus.textContent = 'Error loading current journey.';
    });
  });

  // B. Save Current Journey & Start New Trip
  btnArchiveJourney.addEventListener('click', () => {
    journeyStatus.textContent = 'Archiving current journey...';

    let foundPath = 'tracker/journey';
    db.ref('tracker/journey').once('value').then((snap) => {
      let val = snap.val();
      if (!val) {
        foundPath = 'journey';
        return db.ref('journey').once('value').then(rootSnap => rootSnap.val());
      }
      return val;
    }).then((val) => {
      if (!val) {
        journeyStatus.textContent = 'No active journey points to save.';
        return;
      }

      // Format date for history label
      const now = new Date();
      const dateStr = now.toLocaleDateString() + ' ' + now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      // Save to history in Firebase
      const historyEntry = {
        title: `Trip on ${dateStr}`,
        savedAt: firebase.database.ServerValue.TIMESTAMP,
        formattedDate: dateStr,
        points: val
      };

      return db.ref('history').push(historyEntry).then(() => {
        // Clear active journey from DB
        const p1 = db.ref('tracker/journey').remove();
        const p2 = db.ref('journey').remove();
        return Promise.all([p1, p2]);
      });
    }).then(() => {
      if (journeyPolyline) {
        map.removeLayer(journeyPolyline);
        journeyPolyline = null;
      }
      journeyStatus.textContent = 'Journey saved to History & cleared for next trip!';
    }).catch((err) => {
      console.error('Error archiving journey:', err);
      journeyStatus.textContent = 'Failed to archive journey.';
    });
  });

  // C. Clear Map Display Only
  btnClearJourney.addEventListener('click', () => {
    if (journeyPolyline) {
      map.removeLayer(journeyPolyline);
      journeyPolyline = null;
      journeyStatus.textContent = 'Polyline cleared from map.';
    } else {
      journeyStatus.textContent = 'No polyline to clear.';
    }
  });

  // D. Listen to History in Firebase & Populate Dropdown
  db.ref('history').on('value', (snap) => {
    const val = snap.val();
    historyCache = val || {};

    historySelect.innerHTML = '<option value="">-- Select Saved Journey --</option>';

    if (!val) return;

    Object.keys(val).reverse().forEach((key) => {
      const item = val[key];
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = item.title || item.formattedDate || key;
      historySelect.appendChild(opt);
    });
  });

  // E. View Selected History Journey
  historySelect.addEventListener('change', (e) => {
    const key = e.target.value;
    if (!key || !historyCache[key]) return;

    const item = historyCache[key];
    const val = item.points;

    const rawPoints = [];
    if (Array.isArray(val)) {
      val.forEach(p => { if (p) rawPoints.push(p); });
    } else if (typeof val === 'object') {
      Object.keys(val).forEach(k => { if (val[k]) rawPoints.push(val[k]); });
    }

    rawPoints.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    const coords = rawPoints
      .filter(p => !isNaN(parseFloat(p.lat)) && !isNaN(parseFloat(p.lng)))
      .map(p => [parseFloat(p.lat), parseFloat(p.lng)]);

    if (coords.length > 0) {
      drawJourneyPolyline(coords, `Viewing: ${item.title || 'Saved Journey'}`);
    } else {
      journeyStatus.textContent = 'Selected history entry has no valid coordinates.';
    }
  });
}

// 8. Recenter Floating Button
function setupRecenterButton() {
  document.getElementById('btnRecenter').addEventListener('click', () => {
    if (lastCoords.lat !== null && lastCoords.lng !== null) {
      map.panTo([lastCoords.lat, lastCoords.lng]);
    }
  });
}

// 9. Application Initialization
document.addEventListener('DOMContentLoaded', () => {
  initMap();
  setupFirebaseListeners();
  setupModeSwitcher();
  setupJourneyControls();
  setupRecenterButton();
});
