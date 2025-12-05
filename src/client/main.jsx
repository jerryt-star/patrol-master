import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { createRoot } from 'react-dom/client';

// API 位址
const API_URL = 'https://patrol-master.onrender.com/api/stores';

// 預設位置
const DEFAULT_STATIC_LAT = 25.0330; 
const DEFAULT_STATIC_LNG = 121.5654;
const DEFAULT_CITY = '臺北市';
const DEFAULT_AREA = '信義區';

// 縮放設定
const MAX_ZOOM = 18;
const DEFAULT_STATIC_ZOOM = 17;

// Haversine 公式
const getDistance = (lat1, lon1, lat2, lon2) => {
  const R = 6371; 
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(lat1*(Math.PI/180)) * Math.cos(lat2*(Math.PI/180)) * Math.sin(dLon/2) * Math.sin(dLon/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

// 資料處理
const flattenStoreData = (nestedData) => {
  let stores = [];
  if (!nestedData) return [];
  for (const cityKey in nestedData) {
    const cityData = nestedData[cityKey];
    for (const areaKey in cityData) {
      if (cityData[areaKey]?.data) {
        stores = stores.concat(cityData[areaKey].data);
      }
    }
  }
  return stores.filter(s => s.lat && s.lng && s.name).map((s, i) => ({
      ...s,
      id: s.id || `${s.city}-${s.area}-${i}`
  }));
};

// --- Leaflet 地圖元件 ---
const LeafletMap = ({ centerLat, centerLng, zoom, userLocation, stores, selectedStore, onStoreSelect, proximityRadius, mapControlRef, isWatching, userHeading, followMode, onMapDragStart }) => {
  const mapRef = useRef(null); 
  const mapInstanceRef = useRef(null); 
  const markersRef = useRef([]);
  const userMarkerRef = useRef(null); 
  const userCircleRef = useRef(null); 
  const [isLeafletLoaded, setIsLeafletLoaded] = useState(false);
  
  // 暴露給父元件的方法
  const forceMapResize = useCallback(() => {
    if (mapInstanceRef.current && window.L) {
        window.requestAnimationFrame(() => {
            mapInstanceRef.current.invalidateSize({ pan: false });
        });
    }
  }, []);

  useEffect(() => {
      if (mapControlRef) {
          mapControlRef.current = { 
              forceMapResize,
              flyTo: (lat, lng, z) => {
                  if (mapInstanceRef.current) {
                      mapInstanceRef.current.flyTo([lat, lng], z);
                  }
              }
          };
      }
  }, [mapControlRef, forceMapResize]); 

  // 載入 Leaflet
  useEffect(() => {
    if (window.L) {
      setIsLeafletLoaded(true);
      return;
    }
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    document.head.appendChild(link);
    const script = document.createElement('script');
    script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    script.async = true;
    script.onload = () => setIsLeafletLoaded(true);
    document.body.appendChild(script);
    const style = document.createElement('style');
    style.innerHTML = `
        @keyframes bobbing { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-4px); } }
        .walking-bob { animation: bobbing 1.5s ease-in-out infinite; }
        @keyframes static-glow { 0% { box-shadow: 0 0 0 0 rgba(0, 68, 255, 0.6); } 50% { box-shadow: 0 0 0 10px rgba(0, 68, 255, 0.2); } 100% { box-shadow: 0 0 0 0 rgba(0, 68, 255, 0); } }
        .user-icon-static-glow { animation: static-glow 2s infinite; border-color: #0044FF !important; }
        .leaflet-control-container .leaflet-top { z-index: 800; }
    `;
    document.head.appendChild(style);
  }, []);

  // 初始化地圖
  useEffect(() => {
    if (!isLeafletLoaded || !mapRef.current || mapInstanceRef.current) return;

    const map = window.L.map(mapRef.current, {
        zoomControl: false, 
        maxZoom: MAX_ZOOM, 
        attributionControl: false
    }).setView([centerLat, centerLng], zoom);
    
    window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: MAX_ZOOM, 
    }).addTo(map);

    map.on('dragstart', () => {
        if (onMapDragStart) onMapDragStart();
    });

    mapInstanceRef.current = map;
    setTimeout(() => map.invalidateSize(), 100); 
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLeafletLoaded]); 

  // 視圖控制 (flyTo)
  useEffect(() => {
      if (!mapInstanceRef.current || !isLeafletLoaded) return;
      if (followMode !== 'compass') {
          if (selectedStore) {
              mapInstanceRef.current.flyTo([selectedStore.lat, selectedStore.lng], MAX_ZOOM);
          } else if (followMode === 'center' && userLocation) {
              mapInstanceRef.current.flyTo([userLocation.lat, userLocation.lng], MAX_ZOOM);
          } else {
              mapInstanceRef.current.flyTo([centerLat, centerLng], zoom);
          }
      }
  }, [centerLat, centerLng, zoom, isLeafletLoaded, followMode, userLocation, selectedStore]);

  // 標記繪製
  useEffect(() => {
    if (!mapInstanceRef.current || !isLeafletLoaded) return;
    const map = mapInstanceRef.current;
    const L = window.L;

    markersRef.current.forEach(marker => marker.remove());
    markersRef.current = [];

    const createStoreIcon = (color, size = 30, text = '', isSelected) => {
        const textHtml = text ? `<div style="position: absolute; top: -${size * 0.9}px; left: 50%; transform: translateX(-50%); padding: 4px 8px; background: ${color}; color: white; font-size: 14px; font-weight: 700; border-radius: 9999px; white-space: nowrap; box-shadow: 0 2px 6px rgba(0,0,0,0.5); line-height: 1; z-index: 10;">${text}</div>` : '';
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="${color}" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>`;
        const htmlContent = textHtml + svg; 
        const markerSize = isSelected ? 45 : size;
        return L.divIcon({ className: 'custom-store-icon', html: htmlContent, iconSize: [markerSize, markerSize], iconAnchor: [markerSize / 2, markerSize], popupAnchor: [0, -markerSize] });
    };

    const createUserIcon = (size = 30, heading, isTracking) => {
        const arrowColor = isTracking ? '#0044FF' : '#555555';
        const arrowSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="${arrowColor}" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L12 2 L22 22 L12 18 L2 22 Z" /></svg>`;
        // 修正：+180 度
        const rotationStyle = (heading !== null && heading !== undefined) ? `transform: rotate(${heading + 180}deg);` : ''; 
        const glowClass = !isTracking ? 'user-icon-static-glow' : '';
        const userHtml = `<div class="user-icon-div ${glowClass}" style="width: ${size + 12}px; height: ${size + 12}px; display: flex; align-items: center; justify-content: center; background: white; border-radius: 50%; box-shadow: 0 3px 8px rgba(0, 0, 0, 0.5); border: 3px solid ${arrowColor}; transition: transform 0.1s linear; ${rotationStyle}">${arrowSvg}</div>`;
        return L.divIcon({ className: 'user-icon-container', html: userHtml, iconSize: [size + 12, size + 12], iconAnchor: [(size + 12) / 2, (size + 12) / 2], popupAnchor: [0, -size/2] });
    };

    // 使用者標記
    if (userLocation) {
        const latLng = [userLocation.lat, userLocation.lng];
        const currentIcon = createUserIcon(30, userHeading, isWatching);
        
        let popupContent = `<b>🚶 您的位置</b>`;
        if (userHeading !== null && userHeading !== undefined) popupContent += `<br/>方向: ${userHeading.toFixed(0)}°`;

        if (!userMarkerRef.current) {
             userMarkerRef.current = L.marker(latLng, { icon: currentIcon, zIndexOffset: 500 }).addTo(map).bindPopup(popupContent);
        } else {
             userMarkerRef.current.setLatLng(latLng).setIcon(currentIcon).setPopupContent(popupContent);
        }

        if (isWatching) {
            const radiusInMeters = proximityRadius * 1000;
            if (!userCircleRef.current) {
                userCircleRef.current = L.circle(latLng, { color: '#0044FF', fillColor: '#0044FF', fillOpacity: 0.15, radius: radiusInMeters, weight: 2, interactive: false, zIndexOffset: 400 }).addTo(map);
            } else {
                userCircleRef.current.setLatLng(latLng).setRadius(radiusInMeters);
            }
        } else {
             if (userCircleRef.current) { userCircleRef.current.remove(); userCircleRef.current = null; }
        }
    } else {
        if (userMarkerRef.current) { userMarkerRef.current.remove(); userMarkerRef.current = null; }
        if (userCircleRef.current) { userCircleRef.current.remove(); userCircleRef.current = null; }
    }

    // 店家標記 
    stores.slice(0, 50).forEach(store => {
      const isSelected = selectedStore?.id === store.id;
      const iconColor = isSelected ? '#FFAA00' : '#FF0000'; 
      const iconText = isSelected ? '' : store.name; 
      const icon = createStoreIcon(iconColor, 30, iconText, isSelected); 
      const marker = L.marker([store.lat, store.lng], { icon: icon, zIndexOffset: isSelected ? 1000 : 0 })
      .addTo(map)
      .bindPopup(`<div class="text-center"><strong class="text-gray-800 text-lg">${store.name}</strong><br/><span class="text-xs text-gray-500">${store.city} ${store.area}</span><br/><button class="mt-2 px-2 py-1 bg-blue-500 hover:bg-blue-600 text-white text-xs rounded" onclick="window.open('https://www.google.com/maps/dir/?api=1&destination=${store.lat},${store.lng}', '_blank')">導航</button></div>`);
      
      marker.on('click', () => onStoreSelect(store));
      if (isSelected) marker.openPopup();
      markersRef.current.push(marker);
    });
    
  }, [isLeafletLoaded, userLocation, userHeading, isWatching, stores, selectedStore, onStoreSelect, proximityRadius]); 

  // 地圖容器旋轉 (導航模式)
  const mapRotation = (followMode === 'compass' && userHeading) ? -userHeading : 0;
  const mapScale = mapRotation !== 0 ? 1.5 : 1;

  useEffect(() => {
      if (mapRef.current) {
          mapRef.current.style.transition = 'transform 0.3s ease-out';
          mapRef.current.style.transform = `rotate(${mapRotation}deg) scale(${mapScale})`;
      }
      if (followMode === 'compass' && userLocation && mapInstanceRef.current) {
          mapInstanceRef.current.setView([userLocation.lat, userLocation.lng], MAX_ZOOM, { animate: false });
      }
  }, [mapRotation, mapScale, followMode, userLocation]);

  return (
    <div className="h-full w-full bg-gray-100 rounded-xl shadow-inner relative overflow-hidden">
      <div ref={mapRef} id="leaflet-map-container" className="h-full w-full rounded-xl" />
      <style>{`.custom-store-icon { display: flex; align-items: center; justify-content: center; cursor: pointer; }`}</style>
    </div>
  );
};

// --- App ---
const App = () => {
  const [allStores, setAllStores] = useState([]);
  const [filteredStores, setFilteredStores] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedStore, setSelectedStore] = useState(null);
  
  const [filterCity, setFilterCity] = useState(DEFAULT_CITY);
  const [filterArea, setFilterArea] = useState(DEFAULT_AREA);
  
  const [userLocation, setUserLocation] = useState(null);
  const [userHeading, setUserHeading] = useState(null); 
  const [isWatching, setIsWatching] = useState(false); // 預設：靜態模式
  const [proximityRadius, setProximityRadius] = useState(0.1); 
  
  const [isListOpen, setIsListOpen] = useState(false); 
  // *** 追蹤模式狀態: 'none'(自由), 'center'(鎖定), 'compass'(導航) ***
  const [followMode, setFollowMode] = useState('none'); 

  const watchIdRef = useRef(null); 
  const mapControlRef = useRef(null); 

  const handleListToggle = () => {
    const newState = !isListOpen;
    setIsListOpen(newState);
    setTimeout(() => {
        if (mapControlRef.current && mapControlRef.current.forceMapResize) {
            mapControlRef.current.forceMapResize();
        }
    }, 350); 
  };

  const handleOrientation = useCallback((event) => {
    let heading = event.webkitCompassHeading;
    if (!heading && event.alpha) heading = 360 - event.alpha;
    if (heading !== null && heading !== undefined) setUserHeading(heading);
  }, []);

  useEffect(() => {
    const loadData = async () => {
        try {
            const res = await fetch(API_URL);
            if (!res.ok) throw new Error('API Error');
            const raw = await res.json();
            setAllStores(flattenStoreData(raw));
            setLoading(false);
        } catch (err) {
            console.error(err);
            setError('無法載入店家資料。');
            setLoading(false);
        }
    };
    loadData();
  }, []);
  
  // 修正：定義缺失的 handleRecenter, handleCityChange, handleAreaChange, handleStoreSelect
  const handleRecenter = () => {
    if (userLocation) {
        setFollowMode('center');
        setSelectedStore(null); 
        if (mapControlRef.current && mapControlRef.current.flyTo) {
            mapControlRef.current.flyTo(userLocation.lat, userLocation.lng, DEFAULT_STATIC_ZOOM);
        }
    }
  };

  const handleCityChange = (e) => {
    setFilterCity(e.target.value);
    setFilterArea('');
    setFollowMode('none'); // 切換區域時自動改為自由模式
  };

  const handleAreaChange = (e) => {
    setFilterArea(e.target.value);
    setFollowMode('none');
  };

  const handleStoreSelect = (store) => {
      setSelectedStore(store);
      setFollowMode('none'); // 點擊店家時改為自由模式
  };

  const findLocationBasedOnStores = useCallback((location) => {
    if (!location || allStores.length === 0) return { city: DEFAULT_CITY, area: DEFAULT_AREA }; 
    let nearest = null, minDst = Infinity;
    for (const s of allStores) {
        if (s.lat && s.lng) {
            const dst = getDistance(location.lat, location.lng, s.lat, s.lng);
            if (dst < minDst) { minDst = dst; nearest = s; }
        }
    }
    return nearest ? { city: nearest.city, area: nearest.area } : { city: DEFAULT_CITY, area: DEFAULT_AREA }; 
  }, [allStores]);

  const startWatchingPosition = useCallback(async () => {
    if (watchIdRef.current !== null) return;
    if (!navigator.geolocation) { setError('瀏覽器不支持定位。'); return; }

    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        try {
            const permission = await DeviceOrientationEvent.requestPermission();
            if (permission === 'granted') window.addEventListener('deviceorientation', handleOrientation);
        } catch (e) {}
    } else {
        window.addEventListener('deviceorientation', handleOrientation);
    }

    setFilterCity(''); setFilterArea(''); setSelectedStore(null); setIsWatching(true); setError(''); 
    setFollowMode('center'); 

    watchIdRef.current = navigator.geolocation.watchPosition(
        (pos) => {
            setUserLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude });
            if (pos.coords.heading) setUserHeading(pos.coords.heading);
        },
        (err) => {
            console.error(err);
            if (watchIdRef.current) { navigator.geolocation.clearWatch(watchIdRef.current); watchIdRef.current = null; }
            setIsWatching(false); setFollowMode('none');
            setFilterCity(DEFAULT_CITY); setFilterArea(DEFAULT_AREA);
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  }, [handleOrientation]); 

  const stopWatchingPosition = useCallback(() => {
      if (watchIdRef.current !== null) { navigator.geolocation.clearWatch(watchIdRef.current); watchIdRef.current = null; }
      setIsWatching(false);
      const { city, area } = findLocationBasedOnStores(userLocation);
      setFilterCity(city); setFilterArea(area);
      setSelectedStore(null);
      
      if (userLocation) setFollowMode('center'); else setFollowMode('none');
      
  }, [findLocationBasedOnStores, userLocation]); 

  useEffect(() => {
    if (isWatching) startWatchingPosition(); 
    return () => { if (watchIdRef.current) navigator.geolocation.clearWatch(watchIdRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); 

  useEffect(() => {
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            (position) => {
                const loc = { lat: position.coords.latitude, lng: position.coords.longitude };
                setUserLocation(loc);
                if (position.coords.heading) setUserHeading(position.coords.heading);

                if (!isWatching && allStores.length > 0) {
                    const { city, area } = findLocationBasedOnStores(loc);
                    setFilterCity(city); setFilterArea(area);
                    setFollowMode('center'); 
                }
            },
            (err) => console.warn("Initial geo failed:", err),
            { enableHighAccuracy: true, timeout: 5000 }
        );
    }
    window.addEventListener('deviceorientation', handleOrientation);
    return () => { window.removeEventListener('deviceorientation', handleOrientation); };
  }, [allStores, handleOrientation]); 

  useEffect(() => {
    let results = [...allStores];
    if (userLocation && isWatching) {
        results = allStores.map(s => ({ ...s, distance: getDistance(userLocation.lat, userLocation.lng, s.lat, s.lng) }))
            .filter(s => s.distance <= proximityRadius)
            .sort((a, b) => a.distance - b.distance);
    } else {
        if (filterCity) results = results.filter(s => s.city === filterCity);
        if (filterArea) results = results.filter(s => s.area === filterArea);
        results = results.map(s => { const { distance, ...r } = s; return r; });
    }
    setFilteredStores(results);
  }, [allStores, filterCity, filterArea, userLocation, proximityRadius, isWatching]);

  const cities = useMemo(() => [...new Set(allStores.map(s => s.city))].filter(Boolean).sort(), [allStores]);
  const areas = useMemo(() => {
      if (!filterCity) return [];
      return [...new Set(allStores.filter(s => s.city === filterCity).map(s => s.area))].filter(Boolean).sort();
  }, [allStores, filterCity]);

  const handleModeToggle = () => {
      if (followMode === 'none') {
          if (!userLocation) { startWatchingPosition(); return; }
          setFollowMode('center'); setSelectedStore(null);
          if (mapControlRef.current) mapControlRef.current.flyTo(userLocation.lat, userLocation.lng, DEFAULT_STATIC_ZOOM);
      } else if (followMode === 'center') {
          setFollowMode('compass');
      } else if (followMode === 'compass') {
          setFollowMode('center');
      }
  };
  
  const handleMapDragStart = useCallback(() => {
      if (followMode !== 'none') setFollowMode('none');
  }, [followMode]);

  const mapCenter = useMemo(() => {
      if ((followMode === 'center' || followMode === 'compass') && userLocation) return { lat: userLocation.lat, lng: userLocation.lng, zoom: followMode === 'compass' ? MAX_ZOOM : 17 };
      if (selectedStore) return { lat: selectedStore.lat, lng: selectedStore.lng, zoom: MAX_ZOOM };
      if (filteredStores.length > 0) {
          let lat = 0, lng = 0;
          filteredStores.forEach(s => { lat += s.lat; lng += s.lng; });
          return { lat: lat / filteredStores.length, lng: lng / filteredStores.length, zoom: DEFAULT_STATIC_ZOOM };
      }
      if (userLocation) return { lat: userLocation.lat, lng: userLocation.lng, zoom: 17 };
      return { lat: DEFAULT_STATIC_LAT, lng: DEFAULT_STATIC_LNG, zoom: DEFAULT_STATIC_ZOOM };
  }, [userLocation, followMode, filteredStores, selectedStore]); 

  return (
    <div className="flex flex-col h-[100dvh] bg-gray-50 font-sans overflow-hidden">
        <div className="flex-grow relative z-0 shadow-lg min-h-0">
            <LeafletMap 
                centerLat={mapCenter.lat}
                centerLng={mapCenter.lng}
                zoom={mapCenter.zoom}
                userLocation={userLocation}
                userHeading={userHeading}
                isWatching={isWatching}
                stores={filteredStores}
                selectedStore={selectedStore}
                onStoreSelect={(s) => { setSelectedStore(s); setFollowMode('none'); }}
                proximityRadius={proximityRadius} 
                mapControlRef={mapControlRef}
                followMode={followMode}
                onMapDragStart={handleMapDragStart}
            />
            <div className="absolute bottom-4 right-4 z-[1000] flex flex-col gap-2">
                {userLocation && (
                    <button onClick={handleRecenter} className={`p-3 rounded-full shadow-xl transition-all flex justify-center items-center border-2 ${followMode !== 'none' ? 'bg-blue-100 text-blue-700 border-2 border-blue-500' : 'bg-white text-blue-600 hover:bg-gray-100'}`} title="置中到我的位置">
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064" /><circle cx="12" cy="12" r="3" /></svg>
                    </button>
                )}
                {userLocation && (
                    <button onClick={handleModeToggle} className={`p-3 rounded-full shadow-xl transition-all flex justify-center items-center border-2 ${followMode === 'compass' ? 'bg-green-500 text-white border-green-600' : followMode === 'center' ? 'bg-blue-500 text-white border-blue-600' : 'bg-white text-blue-600 hover:bg-gray-100'}`}>
                        {followMode === 'compass' ? <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M5.05 4.05a7 7 0 119.9 9.9L10 18.9l-4.95-4.95a7 7 0 010-9.9zM10 11a2 2 0 100-4 2 2 0 000 4z" clipRule="evenodd" /></svg> : <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064" /></svg>}
                    </button>
                )}
                <button onClick={isWatching ? stopWatchingPosition : startWatchingPosition} className={`p-3 rounded-full shadow-xl transition-all flex justify-center items-center ${isWatching ? 'bg-red-500 hover:bg-red-600 text-white' : 'bg-white hover:bg-gray-100 text-blue-600 border-2 border-blue-600'}`}>
                    {isWatching ? <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg> : <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" /><path strokeLinecap="round" strokeLinejoin="round" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" /></svg>}
                </button>
            </div>
            {error && <div className="absolute top-4 left-4 right-4 z-[1000] bg-red-100 border border-red-400 text-red-700 px-4 py-2 rounded shadow-lg text-sm">{error}</div>}
            {userLocation && <div className="absolute top-4 left-4 z-[1000] bg-white text-gray-700 px-3 py-1 rounded shadow-lg text-xs font-medium border border-gray-200">{isWatching ? <><span className="text-red-500">• 實時追蹤</span> | 方向: {userHeading !== null ? `${userHeading.toFixed(0)}°` : 'N/A'}</> : <span className="text-blue-500">• 靜態模式</span>}</div>}
        </div>
        <div className={`bg-white shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.1)] z-10 flex flex-col transition-all duration-300 ease-in-out flex-shrink-0 ${isListOpen ? 'h-[40vh]' : 'h-14'}`}>
            <div className="flex-shrink-0 p-3 border-b bg-gray-50 flex justify-between items-center cursor-pointer" onClick={handleListToggle}>
                <h3 className="font-bold text-lg text-gray-700">{isWatching && userLocation ? '附近店家' : '靜態店家列表'} <span className="ml-2 text-sm font-normal text-gray-500">({filteredStores.length})</span></h3>
                <button className="p-1 rounded-full text-gray-500 hover:text-gray-700 transition"><svg xmlns="http://www.w3.org/2000/svg" className={`h-6 w-6 transform transition-transform ${isListOpen ? 'rotate-180' : 'rotate-0'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" /></svg></button>
            </div>
            <div className={`flex-1 overflow-y-auto ${isListOpen ? 'block' : 'hidden'}`}>
                <div className="flex-shrink-0 p-4 border-b bg-white flex flex-col md:flex-row gap-2 items-start md:items-center">
                    <div className="flex gap-2 flex-wrap flex-grow">
                        <select className="p-2 border rounded text-sm w-full md:w-auto" value={filterCity} onChange={handleCityChange} disabled={isWatching}><option value="">所有縣市</option>{cities.map(c => <option key={c} value={c}>{c}</option>)}</select>
                        {filterCity && <select className="p-2 border rounded text-sm w-full md:w-auto" value={filterArea} onChange={handleAreaChange} disabled={isWatching}><option value="">所有區域</option>{areas.map(a => <option key={a} value={a}>{a}</option>)}</select>}
                        {isWatching && userLocation && <select className="p-2 border border-green-300 bg-green-50 rounded text-sm text-green-800 font-medium w-full md:w-auto" value={proximityRadius} onChange={(e) => setProximityRadius(Number(e.target.value))}><option value="0.1">100 公尺</option><option value="0.2">200 公尺</option><option value="0.5">500 公尺</option><option value="1">1 km</option><option value="3">3 km</option><option value="5">5 km</option><option value="10">10 km</option><option value="20">20 km</option></select>}
                    </div>
                </div>
                <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-gray-100">
                    {loading ? <div className="text-center py-10 text-gray-500">載入中...</div> : filteredStores.length === 0 ? <div className="text-center py-10 text-gray-500">無店家資料</div> : filteredStores.map(store => (
                        <div key={store.id} onClick={() => handleStoreSelect(store)} className={`p-4 bg-white rounded-lg shadow-sm border-l-4 cursor-pointer transition-all hover:shadow-md flex justify-between items-center ${selectedStore?.id === store.id ? 'border-blue-500 ring-2 ring-blue-300' : 'border-gray-200 hover:border-blue-300'}`}>
                            <div><h4 className="font-bold text-gray-800">{store.name}</h4><p className="text-xs text-gray-500 mt-0.5">{store.address}</p></div>
                            {store.distance !== undefined && <div className="text-right flex-shrink-0 ml-4"><span className="block text-lg font-extrabold text-green-600 leading-none">{store.distance < 1 ? (store.distance * 1000).toFixed(0) : store.distance.toFixed(1)}</span><span className="text-[10px] text-gray-500">{store.distance < 1 ? '公尺' : 'km'}</span></div>}
                        </div>
                    ))}
                </div>
            </div>
        </div>
    </div>
  );
};

const rootElement = document.getElementById('root');
if (rootElement) { const root = createRoot(rootElement); root.render(<App />); }