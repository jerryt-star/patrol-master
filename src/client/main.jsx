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
const DEFAULT_STATIC_ZOOM = 15;

// Haversine 公式計算距離 (km)
const getDistance = (lat1, lon1, lat2, lon2) => {
  const R = 6371; 
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(lat1*(Math.PI/180)) * Math.cos(lat2*(Math.PI/180)) * Math.sin(dLon/2) * Math.sin(dLon/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

// 資料處理：將巢狀 API 資料扁平化
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
const LeafletMap = ({ centerLat, centerLng, zoom, userLocation, stores, selectedStore, onStoreSelect, proximityRadius, mapControlRef, isWatching, userHeading, followMode, onMapDragStart, onMapMoveEnd }) => {
  const mapRef = useRef(null); 
  const mapInstanceRef = useRef(null); 
  const markersRef = useRef([]);
  const userMarkerRef = useRef(null); 
  const userCircleRef = useRef(null); 
  const [isLeafletLoaded, setIsLeafletLoaded] = useState(false);
  
  // 修正：使用 Ref 儲存回調，避免地圖事件監聽器抓到舊的閉包狀態
  const onMapMoveEndRef = useRef(onMapMoveEnd);
  useEffect(() => {
    onMapMoveEndRef.current = onMapMoveEnd;
  }, [onMapMoveEnd]);

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

  // 載入 Leaflet 資源
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
        @keyframes static-glow { 0% { box-shadow: 0 0 0 0 rgba(0, 68, 255, 0.6); } 50% { box-shadow: 0 0 0 10px rgba(0, 68, 255, 0.2); } 100% { box-shadow: 0 0 0 0 rgba(0, 68, 255, 0); } }
        .user-icon-static-glow { animation: static-glow 2s infinite; border-color: #0044FF !important; }
        .leaflet-control-container .leaflet-top { z-index: 800; }
        .custom-store-icon { display: flex; align-items: center; justify-content: center; cursor: pointer; }
    `;
    document.head.appendChild(style);
  }, []);

  // 初始化地圖實例
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

    map.on('dragstart', () => { if (onMapDragStart) onMapDragStart(); });
    
    // 當地圖停止移動時，觸發更新區域邏輯 (透過 Ref 調用最新函式)
    map.on('moveend', () => {
        const center = map.getCenter();
        if (onMapMoveEndRef.current) onMapMoveEndRef.current(center.lat, center.lng);
    });

    mapInstanceRef.current = map;
    setTimeout(() => map.invalidateSize(), 100); 
  }, [isLeafletLoaded]); 

  // 處理視圖 flyTo (僅在非自由移動模式下觸發)
  useEffect(() => {
      if (!mapInstanceRef.current || !isLeafletLoaded) return;
      if (followMode !== 'none') {
          if (selectedStore) {
              mapInstanceRef.current.flyTo([selectedStore.lat, selectedStore.lng], MAX_ZOOM);
          } else if (followMode === 'center' && userLocation) {
              mapInstanceRef.current.flyTo([userLocation.lat, userLocation.lng], zoom);
          }
      }
  }, [centerLat, centerLng, zoom, isLeafletLoaded, followMode, userLocation, selectedStore]);

  // 繪製標記與圖層
  useEffect(() => {
    if (!mapInstanceRef.current || !isLeafletLoaded) return;
    const map = mapInstanceRef.current;
    const L = window.L;

    markersRef.current.forEach(marker => marker.remove());
    markersRef.current = [];

    const createStoreIcon = (color, size = 30, text = '', isSelected) => {
        const textHtml = text ? `<div style="position: absolute; top: -${size * 0.9}px; left: 50%; transform: translateX(-50%); padding: 4px 8px; background: ${color}; color: white; font-size: 12px; font-weight: 700; border-radius: 9999px; white-space: nowrap; box-shadow: 0 2px 4px rgba(0,0,0,0.3); line-height: 1; z-index: 10;">${text}</div>` : '';
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="${color}" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>`;
        const markerSize = isSelected ? 40 : size;
        return L.divIcon({ className: 'custom-store-icon', html: textHtml + svg, iconSize: [markerSize, markerSize], iconAnchor: [markerSize / 2, markerSize], popupAnchor: [0, -markerSize] });
    };

    const createUserIcon = (size = 30, heading, isTracking) => {
        const arrowColor = isTracking ? '#0044FF' : '#555555';
        const arrowSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="${arrowColor}" stroke="white" stroke-width="2"><path d="M12 2L22 22 L12 18 L2 22 Z" /></svg>`;
        const rotationStyle = (heading !== null && heading !== undefined) ? `transform: rotate(${heading}deg);` : ''; 
        const glowClass = !isTracking ? 'user-icon-static-glow' : '';
        const userHtml = `<div class="user-icon-div ${glowClass}" style="width: ${size + 10}px; height: ${size + 10}px; display: flex; align-items: center; justify-content: center; background: white; border-radius: 50%; box-shadow: 0 2px 6px rgba(0,0,0,0.4); border: 2px solid ${arrowColor}; transition: transform 0.1s linear; ${rotationStyle}">${arrowSvg}</div>`;
        return L.divIcon({ className: 'user-icon-container', html: userHtml, iconSize: [size + 10, size + 10], iconAnchor: [(size + 10) / 2, (size + 10) / 2] });
    };

    // 使用者標記與半徑圓圈
    if (userLocation) {
        const latLng = [userLocation.lat, userLocation.lng];
        const currentIcon = createUserIcon(28, userHeading, isWatching);
        if (!userMarkerRef.current) {
             userMarkerRef.current = L.marker(latLng, { icon: currentIcon, zIndexOffset: 500 }).addTo(map);
        } else {
             userMarkerRef.current.setLatLng(latLng).setIcon(currentIcon);
        }

        if (isWatching) {
            const radiusInMeters = proximityRadius * 1000;
            if (!userCircleRef.current) {
                userCircleRef.current = L.circle(latLng, { color: '#0044FF', fillOpacity: 0.1, radius: radiusInMeters, weight: 1, interactive: false }).addTo(map);
            } else {
                userCircleRef.current.setLatLng(latLng).setRadius(radiusInMeters);
            }
        } else if (userCircleRef.current) {
             userCircleRef.current.remove(); userCircleRef.current = null;
        }
    }

    // 店家標記
    stores.forEach(store => {
      const isSelected = selectedStore?.id === store.id;
      const iconColor = isSelected ? '#FFAA00' : '#EF4444'; 
      const iconText = isSelected ? '' : store.name.substring(0, 10); 
      const icon = createStoreIcon(iconColor, 28, iconText, isSelected); 
      
      const marker = L.marker([store.lat, store.lng], { icon: icon, zIndexOffset: isSelected ? 1000 : 0 })
      .addTo(map)
      .bindPopup(`
        <div class="p-1 text-center">
            <strong class="text-gray-800 text-sm">${store.name}</strong><br/>
            <span class="text-[10px] text-gray-500">${store.address || ''}</span><br/>
            <button class="mt-2 px-3 py-1 bg-blue-500 text-white text-xs rounded-full" 
                    onclick="window.open('https://www.google.com/maps/dir/?api=1&destination=${store.lat},${store.lng}', '_blank')">
                導航至此
            </button>
        </div>
      `);
      
      marker.on('click', () => onStoreSelect(store));
      if (isSelected) marker.openPopup();
      markersRef.current.push(marker);
    });
    
  }, [isLeafletLoaded, userLocation, userHeading, isWatching, stores, selectedStore, proximityRadius]); 

  // 地圖旋轉效果
  const mapRotation = (followMode === 'compass' && userHeading) ? -userHeading : 0;
  useEffect(() => {
      if (mapRef.current) {
          mapRef.current.style.transition = 'transform 0.3s ease-out';
          mapRef.current.style.transform = `rotate(${mapRotation}deg) scale(${mapRotation !== 0 ? 1.5 : 1})`;
      }
  }, [mapRotation]);

  return (
    <div className="h-full w-full bg-gray-100 relative overflow-hidden">
      <div ref={mapRef} className="h-full w-full" />
    </div>
  );
};

// --- App 主程式 ---
const App = () => {
  const [allStores, setAllStores] = useState([]);
  const [filteredStores, setFilteredStores] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedStore, setSelectedStore] = useState(null);
  
  // 篩選狀態
  const [filterCity, setFilterCity] = useState(DEFAULT_CITY);
  const [filterArea, setFilterArea] = useState(DEFAULT_AREA);
  
  // 定位狀態
  const [userLocation, setUserLocation] = useState(null);
  const [userHeading, setUserHeading] = useState(null); 
  const [isWatching, setIsWatching] = useState(false); 
  const [proximityRadius, setProximityRadius] = useState(0.5); 
  const [isListOpen, setIsListOpen] = useState(false); 
  const [followMode, setFollowMode] = useState('none'); 
  const [isRecenterForced, setIsRecenterForced] = useState(false);

  const watchIdRef = useRef(null); 
  const mapControlRef = useRef(null); 

  // 根據座標尋找最近的店家區域 (用來判斷行政區)
  const findLocationBasedOnStores = useCallback((lat, lng) => {
    if (!lat || !lng || allStores.length === 0) return { city: DEFAULT_CITY, area: DEFAULT_AREA }; 
    let nearest = null, minDst = Infinity;
    for (const s of allStores) {
        if (s.lat && s.lng) {
            const dst = getDistance(lat, lng, s.lat, s.lng);
            if (dst < minDst) { minDst = dst; nearest = s; }
        }
    }
    return nearest ? { city: nearest.city, area: nearest.area } : { city: DEFAULT_CITY, area: DEFAULT_AREA }; 
  }, [allStores]);

  // 初始載入資料
  useEffect(() => {
    const loadData = async () => {
        try {
            const res = await fetch(API_URL);
            if (!res.ok) throw new Error('API Error');
            const raw = await res.json();
            const flattened = flattenStoreData(raw);
            setAllStores(flattened);
            setLoading(false);
        } catch (err) {
            setError('無法載入店家資料。');
            setLoading(false);
        }
    };
    loadData();
  }, []);

  // 初始自動偵測當前位置
  useEffect(() => {
    if (navigator.geolocation && allStores.length > 0) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const loc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          setUserLocation(loc);
          // 初始定位成功後，自動切換至該行政區並置中
          const { city, area } = findLocationBasedOnStores(loc.lat, loc.lng);
          setFilterCity(city);
          setFilterArea(area);
          setFollowMode('center');
          setIsRecenterForced(true);
        },
        (err) => console.warn("初始定位失敗:", err),
        { enableHighAccuracy: true, timeout: 5000 }
      );
    }
  }, [allStores.length]);

  // 當地圖中心移動時，自動偵測畫面中心所屬的行政區域
  const handleMapMoveEnd = useCallback((lat, lng) => {
      // 只有在非雷達追蹤模式下才自動切換行政區
      if (!isWatching) {
          const { city, area } = findLocationBasedOnStores(lat, lng);
          // 使用 functional update 確保取得最新狀態並判斷是否需要更新
          setFilterCity(prevCity => {
              if (prevCity !== city) return city;
              return prevCity;
          });
          setFilterArea(prevArea => {
              if (prevArea !== area) return area;
              return prevArea;
          });
      }
  }, [isWatching, findLocationBasedOnStores]);

  // 定位按鈕與追蹤邏輯
  const startWatchingPosition = async () => {
    if (!navigator.geolocation) { setError('不支援定位功能。'); return; }
    setIsWatching(true);
    setFollowMode('center');
    setIsRecenterForced(true);
    
    watchIdRef.current = navigator.geolocation.watchPosition(
        (pos) => {
            const loc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
            setUserLocation(loc);
            if (pos.coords.heading) setUserHeading(pos.coords.heading);
        },
        (err) => {
            setError('定位失敗。');
            setIsWatching(false);
        },
        { enableHighAccuracy: true }
    );
  };

  const stopWatchingPosition = () => {
    if (watchIdRef.current) navigator.geolocation.clearWatch(watchIdRef.current);
    setIsWatching(false);
    setFollowMode('none');
    setIsRecenterForced(false);
  };

  // 核心篩選邏輯
  useEffect(() => {
    let results = [...allStores];
    if (isWatching && userLocation) {
        // 雷達模式：根據半徑篩選
        results = allStores.map(s => ({ ...s, distance: getDistance(userLocation.lat, userLocation.lng, s.lat, s.lng) }))
            .filter(s => s.distance <= proximityRadius)
            .sort((a, b) => a.distance - b.distance);
    } else {
        // 區域模式：顯示該區域「全部」店家標記
        if (filterCity) results = results.filter(s => s.city === filterCity);
        if (filterArea) results = results.filter(s => s.area === filterArea);
        
        if (userLocation) {
            results = results.map(s => ({ ...s, distance: getDistance(userLocation.lat, userLocation.lng, s.lat, s.lng) }))
                .sort((a, b) => a.distance - b.distance);
        }
    }
    setFilteredStores(results);
  }, [allStores, filterCity, filterArea, userLocation, proximityRadius, isWatching]);

  const cities = useMemo(() => [...new Set(allStores.map(s => s.city))].filter(Boolean).sort(), [allStores]);
  const areas = useMemo(() => {
      if (!filterCity) return [];
      return [...new Set(allStores.filter(s => s.city === filterCity).map(s => s.area))].filter(Boolean).sort();
  }, [allStores, filterCity]);

  const handleRecenter = () => {
    if (userLocation) {
        setFollowMode('center');
        setIsRecenterForced(true);
        if (mapControlRef.current) mapControlRef.current.flyTo(userLocation.lat, userLocation.lng, DEFAULT_STATIC_ZOOM);
    }
  };

  return (
    <div className="flex flex-col h-[100dvh] bg-gray-50 overflow-hidden">
        {/* 地圖區 */}
        <div className="flex-grow relative z-0 shadow-inner">
            <LeafletMap 
                centerLat={userLocation?.lat || DEFAULT_STATIC_LAT}
                centerLng={userLocation?.lng || DEFAULT_STATIC_LNG}
                zoom={DEFAULT_STATIC_ZOOM}
                userLocation={userLocation}
                userHeading={userHeading}
                isWatching={isWatching}
                stores={filteredStores}
                selectedStore={selectedStore}
                onStoreSelect={setSelectedStore}
                proximityRadius={proximityRadius}
                mapControlRef={mapControlRef}
                followMode={followMode}
                onMapDragStart={() => { setFollowMode('none'); setIsRecenterForced(false); }}
                onMapMoveEnd={handleMapMoveEnd}
            />
            
            {/* 懸浮控制按鈕 */}
            <div className="absolute bottom-6 right-4 z-[1000] flex flex-col gap-3">
                <button onClick={handleRecenter} className={`p-3 rounded-full shadow-lg transition-all border-2 ${isRecenterForced ? 'bg-blue-100 border-blue-500 text-blue-600' : 'bg-white border-transparent text-gray-600 active:scale-95'}`}>
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><circle cx="12" cy="12" r="3" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 2v2m0 16v2m10-10h-2M4 10H2" /></svg>
                </button>
                <button onClick={isWatching ? stopWatchingPosition : startWatchingPosition} className={`p-3 rounded-full shadow-lg transition-all active:scale-95 ${isWatching ? 'bg-red-500 text-white' : 'bg-blue-600 text-white'}`}>
                    {isWatching ? <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg> : <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" /><circle cx="12" cy="11" r="3" /></svg>}
                </button>
            </div>
            
            {/* 狀態提示 - 畫面中心偵測提示 */}
            <div className="absolute top-4 left-4 z-[1000] bg-white/95 backdrop-blur-sm px-4 py-2 rounded-full shadow-md border border-gray-100 text-xs font-bold flex items-center gap-2">
                <span className={isWatching ? "text-red-500 animate-pulse" : "text-blue-500"}>●</span>
                <span className="text-gray-800">{filterCity} {filterArea}</span>
                <span className="text-gray-400 font-normal">|</span>
                <span className="text-blue-600">共 {filteredStores.length} 間</span>
            </div>
        </div>

        {/* 底部列表區 */}
        <div className={`bg-white shadow-[0_-8px_30px_rgb(0,0,0,0.12)] z-10 transition-all duration-300 ease-in-out ${isListOpen ? 'h-[45vh]' : 'h-16'}`}>
            <div className="h-16 flex items-center justify-between px-5 border-b bg-white cursor-pointer" onClick={() => setIsListOpen(!isListOpen)}>
                <div className="flex flex-col">
                    <span className="text-sm font-black text-gray-800 tracking-tight">{filterCity} {filterArea} 店家探索</span>
                    <span className="text-[10px] text-gray-400 font-medium">拖動地圖自動偵測行政區</span>
                </div>
                <div className="flex items-center gap-4">
                    <span className="bg-blue-50 text-blue-700 px-3 py-1 rounded-full text-xs font-black ring-1 ring-blue-100">{filteredStores.length} 間</span>
                    <svg xmlns="http://www.w3.org/2000/svg" className={`h-5 w-5 text-gray-400 transition-transform duration-300 ${isListOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                </div>
            </div>
            
            <div className={`overflow-hidden h-full bg-gray-50 ${isListOpen ? 'block' : 'hidden'}`}>
                {/* 篩選控制器 */}
                <div className="p-3 bg-white flex gap-2 overflow-x-auto border-b no-scrollbar">
                    <select className="text-xs p-2.5 border border-gray-200 rounded-lg bg-gray-50 focus:ring-2 focus:ring-blue-500 outline-none" value={filterCity} onChange={(e) => { setFilterCity(e.target.value); setFilterArea(''); }} disabled={isWatching}>
                        <option value="">所有縣市</option>
                        {cities.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                    <select className="text-xs p-2.5 border border-gray-200 rounded-lg bg-gray-50 focus:ring-2 focus:ring-blue-500 outline-none" value={filterArea} onChange={(e) => setFilterArea(e.target.value)} disabled={isWatching}>
                        <option value="">所有區域</option>
                        {areas.map(a => <option key={a} value={a}>{a}</option>)}
                    </select>
                </div>

                {/* 清單內容 */}
                <div className="h-full overflow-y-auto p-4 space-y-3 pb-24">
                    {loading ? <div className="text-center py-12 text-gray-400 text-sm animate-pulse font-medium">店家資料載入中...</div> : 
                     filteredStores.length === 0 ? <div className="text-center py-12 text-gray-400 text-sm font-medium">此區域暫無娃娃機店資料</div> :
                     filteredStores.map(store => (
                        <div key={store.id} onClick={() => { setSelectedStore(store); setIsListOpen(false); }} className={`p-4 bg-white rounded-2xl shadow-sm border-l-4 flex justify-between items-center transition-all active:scale-[0.98] ${selectedStore?.id === store.id ? 'border-blue-600 bg-blue-50/30 ring-1 ring-blue-100' : 'border-gray-200 hover:border-blue-300'}`}>
                            <div className="min-w-0 pr-2">
                                <h4 className="font-bold text-gray-800 text-sm truncate mb-0.5">{store.name}</h4>
                                <p className="text-[10px] text-gray-400 truncate font-medium">{store.address || `${store.city}${store.area}`}</p>
                            </div>
                            {store.distance !== undefined && (
                                <div className="text-right flex-shrink-0">
                                    <span className="text-blue-600 font-black text-sm tracking-tighter">
                                        {store.distance < 1 ? (store.distance * 1000).toFixed(0) + 'm' : store.distance.toFixed(1) + 'km'}
                                    </span>
                                </div>
                            )}
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