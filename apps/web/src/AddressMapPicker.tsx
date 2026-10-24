import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

type Coordinates = { latitude: number; longitude: number } | null;

const tileTemplate = import.meta.env.VITE_MAP_TILE_URL_TEMPLATE || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

export function AddressMapPicker({ value, onChange }: { value: Coordinates; onChange: (coordinates: Coordinates) => void }) {
  const element = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const marker = useRef<L.CircleMarker | null>(null);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!element.current || map.current) return;
    const instance = L.map(element.current, { center: value ? [value.latitude, value.longitude] : [18, 0], zoom: value ? 13 : 2, scrollWheelZoom: false });
    map.current = instance;
    L.tileLayer(tileTemplate, { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' })
      .on('tileerror', () => setMessage('Map tiles are temporarily unavailable. You can still enter the address manually.'))
      .addTo(instance);
    instance.on('click', event => onChange({ latitude: Number(event.latlng.lat.toFixed(6)), longitude: Number(event.latlng.lng.toFixed(6)) }));
    return () => { instance.remove(); map.current = null; marker.current = null; };
  }, []);

  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    marker.current?.remove();
    marker.current = null;
    if (value) {
      marker.current = L.circleMarker([value.latitude, value.longitude], { radius: 9, color: '#fff', weight: 3, fillColor: '#315d47', fillOpacity: 1 }).addTo(instance);
      instance.setView([value.latitude, value.longitude], Math.max(instance.getZoom(), 12));
    }
  }, [value?.latitude, value?.longitude]);

  const useLocation = () => {
    if (!navigator.geolocation) { setMessage('Location is not available in this browser. Enter your address manually or select a map point.'); return; }
    setMessage('');
    navigator.geolocation.getCurrentPosition(position => {
      onChange({ latitude: Number(position.coords.latitude.toFixed(6)), longitude: Number(position.coords.longitude.toFixed(6)) });
    }, () => setMessage('Location was not shared. You can enter the address manually or select a point on the map.'), { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 });
  };

  return <fieldset className="addressMapPicker">
    <legend>Optional map pin</legend>
    <p className="muted">Choose a point only if it helps with this saved address. The map provider receives tile viewport requests; precise coordinates are saved with your address only when you save this form. No location is requested until you choose “Use my location.”</p>
    <div ref={element} className="addressMap" role="application" aria-label="Map. Use arrow keys to pan and plus or minus to zoom, or click to choose a location." />
    <p className="mapAttribution">Map tiles by OpenStreetMap contributors. <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">Attribution and tile-use policy</a></p>
    <div className="toolbar"><button type="button" onClick={useLocation}>Use my location</button><button type="button" disabled={!value} onClick={() => onChange(null)}>Clear map pin</button></div>
    {value && <p className="muted" role="status">Map point selected: {value.latitude.toFixed(5)}, {value.longitude.toFixed(5)}</p>}
    {message && <p className="muted" role="status">{message}</p>}
  </fieldset>;
}
