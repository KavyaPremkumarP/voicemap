"use strict";

// -------------------- DOM --------------------

const $ = (id) => document.getElementById(id);

const searchForm = $("searchForm");
const locationInput = $("locationInput");
const locationError = $("locationError");
const searchButton = $("searchButton");
const speakLocationButton = $("speakLocationButton");
const speakAllButton = $("speakAllButton");
const micButton = $("micButton");
const locateButton = $("locateButton");
const stopButton = $("stopButton");
const rateInput = $("rateInput");
const rateLabel = $("rateLabel");
const categoryFilter = $("categoryFilter");
const resultsElement = $("results");
const statusMessage = $("statusMessage");
const voiceStatus = $("voiceStatus");
const osmLink = $("osmLink");
const contrastButton = $("contrastButton");
const textButton = $("textButton");

// -------------------- CONSTANTS --------------------

const OVERPASS_SERVERS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter"
];
const SEARCH_RADII_M = [1500, 5000];   // widen the search if nothing is found
const MAX_PLACES = 100;

const TYPE_LABELS = {
  hospital: "hospital or clinic",
  pharmacy: "pharmacy",
  restaurant: "restaurant",
  cafe: "café",
  atm: "ATM",
  bus_stop: "bus stop",
  place: "place"
};

// Spoken words -> filter value (used by voice commands)
const CATEGORY_WORDS = [
  [/hospital|clinic/, "hospital"],
  [/pharmac|chemist|medical/, "pharmacy"],
  [/restaurant|food/, "restaurant"],
  [/caf[eé]|coffee/, "cafe"],
  [/\batms?\b|cash machine/, "atm"],
  [/\bbus\b/, "bus_stop"]
];

// -------------------- STATE --------------------

let searchedPlace = null;
let locationMarker = null;
let nearbyPlaces = [];
let visiblePlaces = [];
let selectedIndex = -1;
let hasSearched = false;
let nearbyError = "";
let searchCounter = 0;
let activeController = null;
let lastSpoken = "";

// -------------------- MAP SETUP --------------------

// Initial view: India. Change to [-35.9, -84.4], 2 for the world view
// used by https://www.openstreetmap.org/#map=2/-35.9/-84.4
const INITIAL_VIEW = { lat: 20.5937, lon: 78.9629, zoom: 5 };

let map = null;
try {
  map = L.map("map").setView([INITIAL_VIEW.lat, INITIAL_VIEW.lon], INITIAL_VIEW.zoom);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(map);
  map.on("moveend", updateOsmLink);
} catch (error) {
  map = null;
  $("map").textContent =
    "The visual map could not be loaded. Search, lists and voice still work.";
}

function updateOsmLink() {
  if (!map) return;
  const centre = map.getCenter();
  osmLink.href = "https://www.openstreetmap.org/#map=" + map.getZoom() +
    "/" + centre.lat.toFixed(4) + "/" + centre.lng.toFixed(4);
}

function popupNode(title, subtitle) {
  const box = document.createElement("div");
  const strong = document.createElement("strong");
  strong.textContent = title;        // text, never HTML
  box.append(strong, document.createElement("br"), document.createTextNode(subtitle));
  return box;
}

function addMarker(lat, lon, popup, onClick) {
  if (!map) return null;
  const marker = L.marker([lat, lon]).bindPopup(popup);
  if (onClick) marker.on("click", onClick);
  marker.addTo(map);
  return marker;
}

function flyTo(lat, lon, zoom) {
  if (map) map.flyTo([lat, lon], zoom);
}

// -------------------- STATUS + VOICE OUTPUT --------------------

const synthSupported = "speechSynthesis" in window &&
  typeof SpeechSynthesisUtterance !== "undefined";

function setStatus(message, shouldSpeak = false) {
  statusMessage.textContent = message;
  if (shouldSpeak) speak(message);
}

function speak(text) {
  lastSpoken = text;

  if (!synthSupported) {
    voiceStatus.textContent =
      "Voice is not supported by this browser. Try Chrome or Edge.";
    return;
  }

  window.speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "en-IN";
  utterance.rate = parseFloat(rateInput.value) || 0.9;
  utterance.pitch = 1;

  utterance.onstart = () => { voiceStatus.textContent = "🔊 Speaking..."; };
  utterance.onend = () => { voiceStatus.textContent = "Voice finished."; };
  utterance.onerror = (event) => {
    if (event.error !== "canceled" && event.error !== "interrupted") {
      voiceStatus.textContent =
        "Voice could not play. Check your device sound settings.";
    }
  };

  window.speechSynthesis.speak(utterance);
}

function stopSpeaking() {
  if (synthSupported) window.speechSynthesis.cancel();
  voiceStatus.textContent = "Voice stopped.";
}

// -------------------- HELPERS --------------------

function haversineM(a, b) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function bearingWord(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
    Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  const degrees = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  const names = ["north", "north-east", "east", "south-east",
    "south", "south-west", "west", "north-west"];
  return names[Math.round(degrees / 45) % 8];
}

function formatDistance(metres) {
  if (metres < 1000) return Math.max(10, Math.round(metres / 10) * 10) + " metres";
  return (metres / 1000).toFixed(1) + " kilometres";
}

function typeLabel(place) {
  return TYPE_LABELS[place.type] || "place";
}

function describePlace(place) {
  const parts = [`${place.name}, ${typeLabel(place)}.`];
  parts.push(`It is ${formatDistance(place.distanceM)} to the ${place.direction} of the searched location.`);
  if (place.address) parts.push(`Address: ${place.address}.`);
  if (place.hours) parts.push(`Opening hours: ${place.hours}.`);
  if (place.phone) parts.push(`Phone: ${place.phone}.`);
  if (place.wheelchair) parts.push(`Wheelchair access: ${place.wheelchair}.`);
  return parts.join(" ");
}

function shortLabel(place, index) {
  return `Place ${index + 1} of ${visiblePlaces.length}: ${place.name}, ` +
    `${typeLabel(place)}, ${formatDistance(place.distanceM)} ${place.direction}.`;
}

// -------------------- FETCH + JSON --------------------

// Fetch JSON with a timeout, cancellation and friendly error messages.
async function fetchJson(url, options = {}) {
  const { method = "GET", headers, body, signal, timeoutMs = 15000 } = options;
  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const forwardAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", forwardAbort, { once: true });
  }

  try {
    const response = await fetch(url, {
      method, headers, body, signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`The service returned status ${response.status}.`);
    }
    return await response.json();
  } catch (error) {
    if (error.name === "AbortError") {
      if (timedOut) throw new Error("The service took too long to respond.");
      throw error;                       // cancelled by a newer search
    }
    if (error instanceof SyntaxError) {
      throw new Error("The service sent an unreadable response.");
    }
    if (error instanceof TypeError) {
      throw new Error(navigator.onLine
        ? "Could not reach the service. Please try again."
        : "You appear to be offline. Check your internet connection.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", forwardAbort);
  }
}

// -------------------- LOCATION SEARCH --------------------

function labelFromProperties(properties, fallback) {
  const label = [
    properties.name,
    properties.street,
    properties.city || properties.locality || properties.district,
    properties.state,
    properties.country
  ].filter(Boolean)
    .filter((value, index, array) => array.indexOf(value) === index)
    .join(", ");
  return label || fallback;
}

async function getLocation(query, signal) {
  const url = new URL("https://photon.komoot.io/api/");
  url.searchParams.set("q", query);
  url.searchParams.set("limit", "1");

  const data = await fetchJson(url.toString(), { signal });
  const feature = data.features && data.features[0];

  if (!feature || !feature.geometry || !feature.geometry.coordinates) {
    throw new Error("Location not found. Try a city, address, or landmark.");
  }

  const [lon, lat] = feature.geometry.coordinates;
  return {
    lat,
    lon,
    label: labelFromProperties(feature.properties || {}, query)
  };
}

async function getCurrentLocationLabel(lat, lon, signal) {
  const url = new URL("https://photon.komoot.io/reverse");
  url.searchParams.set("lat", lat);
  url.searchParams.set("lon", lon);
  try {
    const data = await fetchJson(url.toString(), { signal, timeoutMs: 8000 });
    const feature = data.features && data.features[0];
    const label = feature ? labelFromProperties(feature.properties || {}, "") : "";
    return label ? `Your current location, near ${label}` : "Your current location";
  } catch (error) {
    if (error.name === "AbortError") throw error;
    return "Your current location";
  }
}

// -------------------- NEARBY PLACES --------------------

function createOverpassQuery(place, radius) {
  const around = `(around:${radius},${place.lat},${place.lon})`;
  return `
    [out:json][timeout:20];
    (
      nwr["amenity"~"^(hospital|clinic|pharmacy|restaurant|cafe|atm|bus_station)$"]${around};
      nwr["highway"="bus_stop"]${around};
    );
    out center tags;
  `;
}

async function getNearbyData(place, radius, signal) {
  const query = createOverpassQuery(place, radius);
  let lastError = null;

  for (const server of OVERPASS_SERVERS) {
    try {
      const data = await fetchJson(server, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: "data=" + encodeURIComponent(query),
        signal,
        timeoutMs: 15000
      });
      // Overpass can answer 200 with an error "remark" when it is overloaded
      if (data.remark && /error|timed out|out of memory/i.test(data.remark)) {
        throw new Error("The nearby places service was busy.");
      }
      return Array.isArray(data.elements) ? data.elements : [];
    } catch (error) {
      if (error.name === "AbortError") throw error;
      lastError = error;                 // try the next server
    }
  }
  throw lastError || new Error("Nearby places could not be loaded.");
}

function getPlaceType(tags) {
  if (tags.amenity === "hospital" || tags.amenity === "clinic") return "hospital";
  if (tags.amenity === "pharmacy") return "pharmacy";
  if (tags.amenity === "restaurant") return "restaurant";
  if (tags.amenity === "cafe") return "cafe";
  if (tags.amenity === "atm") return "atm";
  if (tags.highway === "bus_stop" || tags.amenity === "bus_station") return "bus_stop";
  return "place";
}

function elementCoordinates(element) {
  if (typeof element.lat === "number" && typeof element.lon === "number") {
    return { lat: element.lat, lon: element.lon };
  }
  if (element.center && typeof element.center.lat === "number" &&
      typeof element.center.lon === "number") {
    return { lat: element.center.lat, lon: element.center.lon };
  }
  return null;
}

function toPlace(element, origin) {
  const tags = element.tags || {};
  const coords = elementCoordinates(element);
  if (!coords) return null;

  const type = getPlaceType(tags);
  return {
    id: `${element.type}-${element.id}`,
    name: tags.name || tags.brand || tags.operator || `Unnamed ${TYPE_LABELS[type]}`,
    type,
    lat: coords.lat,
    lon: coords.lon,
    distanceM: haversineM(origin, coords),
    direction: bearingWord(origin, coords),
    address: [
      tags["addr:housenumber"],
      tags["addr:street"],
      tags["addr:suburb"] || tags["addr:city"]
    ].filter(Boolean).join(" "),
    hours: tags.opening_hours || "",
    phone: tags.phone || tags["contact:phone"] || "",
    wheelchair: tags.wheelchair || "",
    marker: null
  };
}

// ----- Backup source: Nominatim search inside a bounding box -----

function nominatimToElement(result) {
  const address = result.address || {};
  const tags = Object.assign({}, result.extratags || {}, { name: result.name || "" });

  if (result.category === "highway") tags.highway = result.type;
  else tags[result.category] = result.type;          // e.g. amenity = hospital

  tags["addr:housenumber"] = address.house_number;
  tags["addr:street"] = address.road;
  tags["addr:suburb"] = address.suburb || address.neighbourhood || address.city;

  if (getPlaceType(tags) === "place") return null;   // not one of our categories
  return {
    type: result.osm_type,
    id: result.osm_id,
    lat: parseFloat(result.lat),
    lon: parseFloat(result.lon),
    tags
  };
}

async function getNearbyFromNominatim(place, radius, signal) {
  const dLat = radius / 111320;
  const dLon = radius / (111320 * Math.cos((place.lat * Math.PI) / 180));
  const viewbox = [place.lon - dLon, place.lat + dLat, place.lon + dLon, place.lat - dLat].join(",");
  const terms = ["hospital", "pharmacy", "restaurant", "cafe", "atm", "bus stop"];

  const elements = [];
  let failures = 0;
  let lastError = null;

  for (let i = 0; i < terms.length; i++) {
    if (i > 0) {                                     // Nominatim allows ~1 request per second
      await new Promise((resolve) => setTimeout(resolve, 1100));
      if (signal && signal.aborted) throw new DOMException("Aborted", "AbortError");
    }

    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("q", terms[i]);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("viewbox", viewbox);
    url.searchParams.set("bounded", "1");
    url.searchParams.set("limit", "15");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("extratags", "1");

    try {
      const data = await fetchJson(url.toString(), { signal, timeoutMs: 12000 });
      if (Array.isArray(data)) {
        data.map(nominatimToElement).filter(Boolean).forEach((e) => elements.push(e));
      }
    } catch (error) {
      if (error.name === "AbortError") throw error;
      failures++;
      lastError = error;
    }
  }

  if (failures === terms.length) throw lastError;
  return elements;
}

async function loadNearbyPlaces(place, thisSearch, signal) {
  try {
    let elements = [];
    let radiusUsed = SEARCH_RADII_M[0];
    try {
      for (const radius of SEARCH_RADII_M) {
        radiusUsed = radius;
        elements = await getNearbyData(place, radius, signal);
        if (elements.length > 0) break;    // found something, stop widening
      }
    } catch (overpassError) {
      if (overpassError.name === "AbortError") throw overpassError;
      // Main service unreachable: use the backup source
      if (thisSearch === searchCounter) {
        setStatus("The main places service is not responding. Trying a backup service, this takes about ten seconds...", true);
      }
      radiusUsed = 3000;
      elements = await getNearbyFromNominatim(place, radiusUsed, signal);
    }
    if (thisSearch !== searchCounter) return;
    nearbyError = "";

    const seen = new Set();
    nearbyPlaces = elements
      .map((element) => toPlace(element, place))
      .filter(Boolean)
      .filter((item) => !seen.has(item.id) && seen.add(item.id))
      .sort((a, b) => a.distanceM - b.distanceM)
      .slice(0, MAX_PLACES);

    hasSearched = true;
    renderPlaces();

    setStatus(
      nearbyPlaces.length
        ? `Location shown. Found ${nearbyPlaces.length} nearby places within about ${radiusUsed / 1000} km. ` +
          "Press Read nearby places, or tab to the list and use the arrow keys."
        : "Location shown. No nearby places were returned for this search.",
      true
    );
  } catch (error) {
    if (thisSearch !== searchCounter) return;

    nearbyPlaces = [];
    hasSearched = true;
    nearbyError = error.message || "Please try again.";
    renderPlaces();
    setStatus(
      "Your location is shown on the map, but nearby places could not load. " +
      (error.message || "") + " Please try again.",
      true
    );
  }
}

// -------------------- SEARCH FLOW --------------------

function setBusy(isBusy) {
  searchButton.disabled = isBusy;
  locateButton.disabled = isBusy;
  searchButton.textContent = isBusy ? "Searching..." : "Search";
}

function showSearchedPlace(place) {
  searchedPlace = place;
  nearbyPlaces = [];
  visiblePlaces = [];
  selectedIndex = -1;
  refreshMarkers();
  flyTo(place.lat, place.lon, 15);

  if (locationMarker && map) map.removeLayer(locationMarker);
  locationMarker = addMarker(place.lat, place.lon,
    popupNode("Selected location", place.label));
  if (locationMarker) locationMarker.openPopup();
}

// resolvePlace(signal) returns a place object {lat, lon, label}
async function startSearch(resolvePlace) {
  const thisSearch = ++searchCounter;
  if (activeController) activeController.abort();
  const controller = new AbortController();
  activeController = controller;

  setBusy(true);
  hasSearched = false;
  nearbyError = "";
  resultsElement.replaceChildren();
  const loading = document.createElement("p");
  loading.textContent = "Searching…";
  resultsElement.appendChild(loading);
  setStatus("Finding your location...", true);
  voiceStatus.textContent = "Voice ready.";

  try {
    const place = await resolvePlace(controller.signal);
    if (thisSearch !== searchCounter) return;

    showSearchedPlace(place);
    setStatus("Location found: " + place.label + ". Loading nearby places...");
    await loadNearbyPlaces(place, thisSearch, controller.signal);
  } catch (error) {
    if (thisSearch !== searchCounter) return;
    resultsElement.replaceChildren();
    const message = document.createElement("p");
    message.textContent = "Search for a location to discover nearby places.";
    resultsElement.appendChild(message);
    setStatus(error.message || "Something went wrong. Please try again.", true);
  } finally {
    if (thisSearch === searchCounter) {
      setBusy(false);
      activeController = null;
    }
  }
}

// -------------------- FORM VALIDATION --------------------

function validateQuery() {
  const value = locationInput.value.trim();
  let message = "";

  if (!value) message = "Please enter a place, address or landmark.";
  else if (value.length < 3) message = "Please type at least 3 characters.";
  else if (!/[\p{L}\p{N}]/u.test(value)) message = "Please use letters or numbers.";

  locationError.textContent = message;
  locationError.classList.toggle("hidden", !message);
  locationInput.setAttribute("aria-invalid", message ? "true" : "false");

  if (message) {
    speak(message);
    locationInput.focus();
  }
  return !message;
}

// -------------------- RENDER PLACES --------------------

function refreshMarkers() {
  nearbyPlaces.forEach((place) => {
    if (place.marker && map) map.removeLayer(place.marker);
    place.marker = null;
  });

  visiblePlaces.forEach((place) => {
    place.marker = addMarker(
      place.lat, place.lon,
      popupNode(place.name, typeLabel(place)),
      () => {
        const index = visiblePlaces.indexOf(place);
        if (index >= 0) selectPlace(index, { full: true, fly: false, focus: false });
      }
    );
  });
}

function showOnMap(place) {
  flyTo(place.lat, place.lon, 17);
  if (place.marker) place.marker.openPopup();
}

function selectPlace(index, options = {}) {
  const { full = false, fly = true, focus = true } = options;
  if (!visiblePlaces.length) return;

  index = Math.max(0, Math.min(visiblePlaces.length - 1, index));
  selectedIndex = index;
  const place = visiblePlaces[index];

  const cards = resultsElement.querySelectorAll(".place-card");
  cards.forEach((card, i) => card.classList.toggle("is-selected", i === index));
  const card = cards[index];
  if (card) {
    card.scrollIntoView({ block: "nearest" });
    if (focus) card.querySelector(".place-name").focus();
  }

  if (fly) showOnMap(place);
  speak(full ? describePlace(place) : shortLabel(place, index));
}

function buildCard(place, index) {
  const card = document.createElement("article");
  card.className = "place-card";

  const heading = document.createElement("h3");
  const nameButton = document.createElement("button");
  nameButton.type = "button";
  nameButton.className = "place-name";
  nameButton.textContent = place.name;
  nameButton.setAttribute("aria-label",
    `${place.name}, ${typeLabel(place)}. Activate to hear details.`);
  nameButton.addEventListener("click", () => selectPlace(index, { full: true }));
  heading.appendChild(nameButton);

  const type = document.createElement("p");
  type.textContent = "Category: " + typeLabel(place);

  const distance = document.createElement("p");
  distance.textContent =
    `Distance: ${formatDistance(place.distanceM)} to the ${place.direction}`;

  card.append(heading, type, distance);

  if (place.address) {
    const address = document.createElement("p");
    address.textContent = "Address: " + place.address;
    card.appendChild(address);
  }

  const actions = document.createElement("div");
  actions.className = "place-actions";

  const showButton = document.createElement("button");
  showButton.type = "button";
  showButton.className = "btn";
  showButton.textContent = "📍 Show on map";
  showButton.addEventListener("click", () => showOnMap(place));

  const hearButton = document.createElement("button");
  hearButton.type = "button";
  hearButton.className = "btn";
  hearButton.textContent = "🔊 Hear details";
  hearButton.addEventListener("click", () => speak(describePlace(place)));

  actions.append(showButton, hearButton);
  card.appendChild(actions);
  return card;
}

function renderPlaces() {
  const category = categoryFilter.value;
  visiblePlaces = category === "all"
    ? nearbyPlaces.slice()
    : nearbyPlaces.filter((place) => place.type === category);
  selectedIndex = -1;

  refreshMarkers();
  resultsElement.replaceChildren();

  if (visiblePlaces.length === 0) {
    const message = document.createElement("p");
    message.textContent = !hasSearched
      ? "Search for a location to discover nearby places."
      : nearbyError
        ? "Nearby places could not be loaded. " + nearbyError
        : nearbyPlaces.length === 0
          ? "No hospitals, pharmacies, restaurants, cafés, ATMs or bus stops were found within about 5 km. " +
            "Try a more specific area, such as a neighbourhood or landmark."
          : "No places match this category.";
    resultsElement.appendChild(message);

    if (hasSearched && nearbyError && searchedPlace) {
      const retryButton = document.createElement("button");
      retryButton.type = "button";
      retryButton.className = "btn bg-[#1769aa] text-white font-bold px-4 py-2 rounded-lg mt-2";
      retryButton.textContent = "🔄 Try again";
      retryButton.addEventListener("click", () => startSearch(async () => searchedPlace));
      resultsElement.appendChild(retryButton);
    }
    return;
  }

  visiblePlaces.forEach((place, index) => {
    resultsElement.appendChild(buildCard(place, index));
  });
}

// -------------------- VOICE BUTTONS --------------------

function speakLocation() {
  if (!searchedPlace) {
    setStatus("Search for a location first.", true);
    return;
  }
  speak("Your selected location is " + searchedPlace.label);
}

function speakAllNearby() {
  if (visiblePlaces.length === 0) {
    setStatus("No nearby places are loaded yet. Search for a location first.", true);
    return;
  }

  const total = visiblePlaces.length;
  const list = visiblePlaces.slice(0, 10).map((place, index) =>
    `${index + 1}. ${place.name}, ${typeLabel(place)}, ` +
    `${formatDistance(place.distanceM)} ${place.direction}.`);
  const extra = total > 10 ? ` And ${total - 10} more in the list.` : "";

  speak(`${total} nearby places. ${list.join(" ")}${extra}`);
}

function useMyLocation() {
  if (!("geolocation" in navigator)) {
    setStatus("Your browser does not support location access.", true);
    return;
  }

  setStatus("Asking for your location...", true);
  navigator.geolocation.getCurrentPosition(
    (position) => {
      const { latitude, longitude } = position.coords;
      startSearch(async (signal) => ({
        lat: latitude,
        lon: longitude,
        label: await getCurrentLocationLabel(latitude, longitude, signal)
      }));
    },
    (error) => {
      setStatus(error.code === 1
        ? "Location permission was denied."
        : "Could not determine your location.", true);
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

// -------------------- VOICE COMMANDS --------------------

const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let recognizing = false;

function categoryFromWords(text) {
  for (const [pattern, value] of CATEGORY_WORDS) {
    if (pattern.test(text)) return value;
  }
  return null;
}

function handleVoiceCommand(raw) {
  const text = raw.toLowerCase().trim().replace(/[.!?]+$/, "");
  let match;

  if ((match = text.match(/^(?:search for|search|go to|look for)\s+(.+)/))) {
    locationInput.value = match[1];
    if (validateQuery()) {
      startSearch((signal) => getLocation(match[1], signal));
    }
  } else if (/^(use my location|locate me|near me)/.test(text)) {
    useMyLocation();
  } else if (/^(where am i|my location|current location)/.test(text)) {
    speakLocation();
  } else if ((match = text.match(/^(?:show|filter|only)\s+(.+)/))) {
    const category = /\ball\b|everything/.test(match[1]) ? "all" : categoryFromWords(match[1]);
    if (!category) {
      speak("I did not recognise that category. Try hospitals, pharmacies, restaurants, cafés, ATMs or bus stops.");
      return;
    }
    categoryFilter.value = category;
    renderPlaces();
    const label = category === "all" ? "all places" : (categoryFilter.selectedOptions[0].textContent);
    setStatus(`Showing ${label}. ${visiblePlaces.length} found.`, true);
  } else if (/^(read nearby|read all|read places|nearby|list)/.test(text)) {
    speakAllNearby();
  } else if (/^(next|down)\b/.test(text)) {
    selectPlace(selectedIndex < 0 ? 0 : selectedIndex + 1);
  } else if (/^(previous|back|up)\b/.test(text)) {
    selectPlace(selectedIndex < 0 ? 0 : selectedIndex - 1);
  } else if ((match = text.match(/^(?:number|place|result)\s+(\d+)/))) {
    selectPlace(parseInt(match[1], 10) - 1, { full: true });
  } else if (/^(read|details|more|open)\b/.test(text)) {
    selectPlace(selectedIndex < 0 ? 0 : selectedIndex, { full: true });
  } else if (/^(repeat|again)\b/.test(text)) {
    speak(lastSpoken || "Nothing to repeat yet.");
  } else if (/^(stop|quiet|silence)\b/.test(text)) {
    stopSpeaking();
  } else {
    speak(`I heard "${raw}", but that is not a command. Try: search for a place, show hospitals, read nearby, next, previous, read, repeat, or stop.`);
  }
}

function toggleMicrophone() {
  if (!SpeechRecognitionAPI) {
    setStatus("Voice commands are not supported in this browser. Please use Chrome or Edge, or type your search.", true);
    return;
  }
  if (recognizing && recognition) {
    recognition.stop();
    return;
  }

  if (synthSupported) window.speechSynthesis.cancel();

  recognition = new SpeechRecognitionAPI();
  recognition.lang = "en-IN";
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;

  recognition.onstart = () => {
    recognizing = true;
    micButton.setAttribute("aria-pressed", "true");
    micButton.textContent = "🎤 Listening... (click to stop)";
    voiceStatus.textContent = "Listening for a command...";
  };
  recognition.onresult = (event) => handleVoiceCommand(event.results[0][0].transcript);
  recognition.onerror = (event) => {
    setStatus(event.error === "not-allowed"
      ? "Microphone permission was denied."
      : event.error === "no-speech"
        ? "I did not hear anything. Please try again."
        : "Voice recognition error. Please try again.", true);
  };
  recognition.onend = () => {
    recognizing = false;
    micButton.setAttribute("aria-pressed", "false");
    micButton.textContent = "🎤 Voice command";
  };
  recognition.start();
}

// -------------------- EVENTS --------------------

// 1. submit: validate, then search
searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!validateQuery()) return;
  const query = locationInput.value.trim();
  startSearch((signal) => getLocation(query, signal));
});

// 2. input: re-validate live once an error is showing
locationInput.addEventListener("input", () => {
  if (!locationError.classList.contains("hidden")) validateQuery();
});

// 3. change: category filter
categoryFilter.addEventListener("change", () => {
  renderPlaces();
  if (hasSearched) {
    setStatus(`Showing ${visiblePlaces.length} place${visiblePlaces.length === 1 ? "" : "s"}.`);
  }
});

// 4. click: voice and location buttons
speakLocationButton.addEventListener("click", speakLocation);
speakAllButton.addEventListener("click", speakAllNearby);
micButton.addEventListener("click", toggleMicrophone);
locateButton.addEventListener("click", useMyLocation);
stopButton.addEventListener("click", stopSpeaking);

// 5. keydown: arrow keys move between place names (each is read aloud)
resultsElement.addEventListener("keydown", (event) => {
  if (!event.target.classList.contains("place-name")) return;

  const names = [...resultsElement.querySelectorAll(".place-name")];
  const current = names.indexOf(event.target);
  let next = null;

  if (event.key === "ArrowDown") next = current + 1;
  else if (event.key === "ArrowUp") next = current - 1;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = names.length - 1;
  if (next === null) return;

  event.preventDefault();
  if (next >= 0 && next < names.length) selectPlace(next);
});

// 6. keydown: global shortcuts
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") { stopSpeaking(); return; }

  const tag = document.activeElement ? document.activeElement.tagName : "";
  if (["INPUT", "SELECT", "TEXTAREA"].includes(tag)) return;

  if (event.key === "/") {
    event.preventDefault();
    locationInput.focus();
  } else if (event.key.toLowerCase() === "r") {
    speak(lastSpoken || "Nothing to repeat yet.");
  }
});

// 7. speech speed slider
rateInput.addEventListener("input", () => {
  rateLabel.textContent = parseFloat(rateInput.value).toFixed(1) + "×";
});
rateInput.addEventListener("change", () => speak("This is the new speaking speed."));

// 8. accessibility toggles
contrastButton.addEventListener("click", () => {
  const on = document.body.classList.toggle("hc");
  contrastButton.setAttribute("aria-pressed", String(on));
  setStatus(on ? "High contrast on." : "High contrast off.", true);
});
textButton.addEventListener("click", () => {
  const on = document.documentElement.style.fontSize !== "125%";
  document.documentElement.style.fontSize = on ? "125%" : "";
  textButton.setAttribute("aria-pressed", String(on));
  setStatus(on ? "Large text on." : "Large text off.", true);
});

// 9. connectivity feedback
window.addEventListener("offline", () => setStatus("You are offline.", true));
window.addEventListener("online", () => setStatus("You are back online.", true));

// -------------------- INIT --------------------

if (!synthSupported) {
  voiceStatus.textContent = "Voice is not supported by this browser. Try Chrome or Edge.";
}
if (!SpeechRecognitionAPI) micButton.title = "Voice commands need Chrome or Edge";
updateOsmLink();
renderPlaces();