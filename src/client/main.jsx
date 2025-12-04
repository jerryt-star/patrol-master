import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { createRoot } from 'react-dom/client';

// API 位址 - 使用您提供的 URL 模擬數據源
const API_URL = 'https://patrol-master.onrender.com/api/stores';

// *** 台北市信義區中心 (無定位資訊或無篩選結果時的最終回退地圖位置) ***
const DEFAULT_STATIC_LAT = 25.0330; 
const DEFAULT_STATIC_LNG = 121.5654;
const DEFAULT_CITY = '臺北市';
const DEFAULT_AREA = '信義區';

// *** 地圖最大縮放級別 (用於選中店家或實時追蹤) ***
const MAX_ZOOM = 18;
// 靜態篩選模式的預設縮放級別 (聚焦在城市/區域)
const DEFAULT_STATIC_ZOOM = 13; // 將預設縮放調低一點，以便看到整個區域


// Haversine 公式：計算兩點之間的距離 (公里)
const getDistance = (lat1, lon1, lat2, lon2) => {
  const R = 6371; // 地球半徑 (公里)
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(lat1*(Math.PI/180)) * Math.cos(lat2*(Math.PI/180)) * Math.sin(dLon/2) * Math.sin(dLon/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

// 展平巢狀的店家資料結構
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
  // 過濾掉沒有座標的店家，並確保每個店家都有唯一的 ID
  return stores.filter(s => s.lat && s.lng && s.name).map((s, i) => ({
      ...s,
      id: s.id || `${s.city}-${s.area}-${i}`
  }));
};

// --- Leaflet 地圖整合元件 ---
const LeafletMap = ({ centerLat, centerLng, zoom, userLocation, stores, selectedStore, onStoreSelect, proximityRadius }) => {
  const mapRef = useRef(null);
  const mapInstanceRef = useRef(null);
  const markersRef = useRef([]);
  const userMarkerRef = useRef(null); 
  const userCircleRef = useRef(null); 
  const [isLeafletLoaded, setIsLeafletLoaded] = useState(false);

  // 1. 動態載入 Leaflet 資源 (CSS & JS)
  useEffect(() => {
    if (window.L) {
      setIsLeafletLoaded(true);
      return;
    }

    // 載入 Leaflet CSS
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    document.head.appendChild(link);

    // 載入 Leaflet JavaScript
    const script = document.createElement('script');
    script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    script.async = true;
    script.onload = () => setIsLeafletLoaded(true);
    document.body.appendChild(script);

    // 添加自定義 CSS 來處理使用者圖標的動畫 (維持原有的 bobbing 動畫)
    const style = document.createElement('style');
    style.innerHTML = `
        @keyframes bobbing {
            0%, 100% { transform: translateY(0); }
            50% { transform: translateY(-4px); } /* 上移 4px */
        }
        .walking-bob {
            animation: bobbing 1.5s ease-in-out infinite;
        }
    `;
    document.head.appendChild(style);

    // 清理函數：移除 Leaflet 資源
    return () => {
        document.head.removeChild(link);
        document.body.removeChild(script);
        document.head.removeChild(style);
        // 如果地圖實例存在，則銷毀它
        if (mapInstanceRef.current) {
            mapInstanceRef.current.remove();
            mapInstanceRef.current = null;
        }
    };
  }, []);

  // 2. 初始化地圖
  useEffect(() => {
    if (!isLeafletLoaded || !mapRef.current || mapInstanceRef.current) return;

    const map = window.L.map(mapRef.current, {
        zoomControl: false, 
        maxZoom: MAX_ZOOM, 
    }).setView([centerLat, centerLng], zoom);
    
    window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: MAX_ZOOM, 
    }).addTo(map);

    window.L.control.zoom({ position: 'topright' }).addTo(map);

    mapInstanceRef.current = map;
    // 延遲刷新地圖，避免因容器大小未定而產生灰色區塊
    setTimeout(() => map.invalidateSize(), 100); 

  // 只有在 Leaflet 載入和 ref 改變時運行初始化
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLeafletLoaded, mapRef]); 

  // 3. 處理容器大小變化 (使用 ResizeObserver)
  useEffect(() => {
    if (!mapInstanceRef.current || !isLeafletLoaded) return;

    const resizeObserver = new ResizeObserver(() => {
        if (mapInstanceRef.current) {
            mapInstanceRef.current.invalidateSize({ pan: false }); 
        }
    });

    if (mapRef.current) {
        resizeObserver.observe(mapRef.current);
    }
    
    return () => {
        resizeObserver.disconnect();
    };

  }, [isLeafletLoaded]); 

  // 4. 繪製和更新標記/定位邏輯
  useEffect(() => {
    if (!mapInstanceRef.current || !isLeafletLoaded) return;

    const map = mapInstanceRef.current;
    const L = window.L;

    // 清除舊店家標記 
    markersRef.current.forEach(marker => marker.remove());
    markersRef.current = [];
    
    // --- 圖標生成器 ---

    // 娃娃機店標記的 SVG 圖標生成器
    const createStoreIcon = (color, size = 30, text = '', isSelected) => {
        // 店家名稱標籤
        const textHtml = text ? `
            <div style="
                position: absolute; 
                top: -${size * 0.9}px; 
                left: 50%; 
                transform: translateX(-50%);
                padding: 4px 8px; 
                background: ${color}; 
                color: white; 
                font-size: 14px; 
                font-weight: 700; 
                border-radius: 9999px; 
                white-space: nowrap;
                box-shadow: 0 1px 4px rgba(0,0,0,0.4);
                line-height: 1;
                z-index: 10;
            ">
                ${text}
            </div>
        ` : '';
        
        // 標記的 SVG
        const svg = `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="${color}" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path>
          <circle cx="12" cy="10" r="3"></circle>
        </svg>`;

        const htmlContent = `
            ${textHtml}
            ${svg}
        `;

        const markerSize = isSelected ? 40 : size;
        
        return L.divIcon({
            className: 'custom-store-icon',
            html: htmlContent,
            iconSize: [markerSize, markerSize],
            iconAnchor: [markerSize / 2, markerSize],
            popupAnchor: [0, -markerSize]
        });
    };

    // 使用者標記的 SVG 圖標生成器
    const createUserIcon = (size = 30) => {
        const walkingStickFigureSvg = `
            <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="4" r="1.5" fill="#3b82f6" stroke="none"/> 
                <path d="M12 5.5v8"/> 
                <path d="M9 10l-2 2"/> 
                <path d="M15 10l2 2"/> 
                <path d="M12 13.5l-3 5"/> 
                <path d="M12 13.5l3 4"/> 
            </svg>
        `;
        
        const walkingSvg = `
        <div class="user-icon-pulse-wrapper walking-bob" style="width: ${size + 4}px; height: ${size + 4}px; display: flex; align-items: center; justify-content: center; background: white; border-radius: 50%; box-shadow: 0 0 5px rgba(0, 0, 0, 0.5); border: 2px solid #3b82f6;">
            ${walkingStickFigureSvg}
        </div>`;

        return L.divIcon({
            className: 'user-icon-container',
            html: walkingSvg,
            iconSize: [size + 10, size + 10], 
            iconAnchor: [(size + 10) / 2, size + 10], 
            popupAnchor: [0, -size]
        });
    };

    const userIcon = createUserIcon(30); 

    // A. 更新或標記使用者位置和半徑圈
    const isTracking = !!userLocation;
    if (isTracking) {
        const latLng = [userLocation.lat, userLocation.lng];
        const radiusInMeters = proximityRadius * 1000;
        
        // 1. 更新使用者標記
        if (!userMarkerRef.current) {
             userMarkerRef.current = L.marker(latLng, { icon: userIcon, zIndexOffset: 500 })
                .addTo(map)
                .bindPopup(`<b>🚶 您的位置</b>`)
                .openPopup();
        } else {
             userMarkerRef.current.setLatLng(latLng);
        }

        // 2. 更新半徑圈 
        if (!userCircleRef.current) {
            userCircleRef.current = L.circle(latLng, {
                color: '#3b82f6',
                fillColor: '#3b82f6',
                fillOpacity: 0.1,
                radius: radiusInMeters,
                weight: 2,
                interactive: false,
                zIndexOffset: 400 
            }).addTo(map);
        } else {
            userCircleRef.current.setLatLng(latLng).setRadius(radiusInMeters);
        }

        // 只有在未選中店家時，才根據追蹤邏輯移動視圖
        if (!selectedStore) {
            map.flyTo(latLng, MAX_ZOOM);
        }

    } else {
        // 如果沒有 userLocation，移除使用者標記和半徑圈
        if (userMarkerRef.current) {
            userMarkerRef.current.remove();
            userMarkerRef.current = null;
        }
        if (userCircleRef.current) {
            userCircleRef.current.remove();
            userCircleRef.current = null;
        }
    }


    // B. 標記店家 (限制數量避免性能問題)
    stores.slice(0, 50).forEach(store => {
      const isSelected = selectedStore?.id === store.id;

      let distanceHtml = '';
      if (store.distance !== undefined) {
          const isMeters = store.distance < 1;
          const value = isMeters ? (store.distance * 1000).toFixed(0) : store.distance.toFixed(1);
          const unit = isMeters ? '公尺' : 'km';
          distanceHtml = `<span class="text-green-600 font-bold">${value} ${unit}</span><br/>`;
      }

      // 根據是否選中，決定標記顏色、大小和是否顯示名稱
      const iconColor = isSelected ? '#fbbf24' : '#ef4444'; 
      // 未選中時顯示名稱，選中時不顯示 (名稱會被 PopUp 遮住)
      const iconText = isSelected ? '' : store.name; 
      
      const icon = createStoreIcon(iconColor, 30, iconText, isSelected); 

      const marker = L.marker([store.lat, store.lng], { 
          icon: icon, 
          zIndexOffset: isSelected ? 1000 : 0 
      })
      .addTo(map)
      .bindPopup(`
        <div class="text-center">
            <strong class="text-gray-800 text-lg">${store.name}</strong><br/>
            <span class="text-xs text-gray-500">${store.city} ${store.area}</span><br/>
            ${distanceHtml}
            <button class="mt-2 px-2 py-1 bg-blue-500 hover:bg-blue-600 text-white text-xs rounded transition-colors" onclick="window.open('https://www.google.com/maps/dir/?api=1&destination=${store.lat},${store.lng}', '_blank')">導航</button>
        </div>
      `);

      // 點擊標記時，更新選中的店家狀態
      marker.on('click', () => {
          onStoreSelect(store);
      });

      if (isSelected) {
          marker.openPopup();
      }

      markersRef.current.push(marker);
    });
    
    // C. 最終地圖視圖設定 (覆蓋原有的邏輯)
    if (selectedStore) {
        // 鎖定選中的店家
        map.flyTo([selectedStore.lat, selectedStore.lng], MAX_ZOOM);
    } else if (!isTracking) {
        // 靜態模式：居中到篩選結果的中心點或預設中心
        map.flyTo([centerLat, centerLng], DEFAULT_STATIC_ZOOM);
    } 
    // 追蹤模式已經在 (A) 區塊處理了 flyTo

  }, [isLeafletLoaded, userLocation, stores, selectedStore, onStoreSelect, centerLat, centerLng, proximityRadius]); 

  // 將 height-full 確保地圖元件完全填滿父層容器
  return <div ref={mapRef} id="leaflet-map-container" className="h-full w-full bg-gray-100 rounded-lg" />;
};

// --- 主要 App 邏輯 ---

const App = () => {
  const [allStores, setAllStores] = useState([]);
  const [filteredStores, setFilteredStores] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedStore, setSelectedStore] = useState(null);
  
  // 篩選狀態
  const [filterCity, setFilterCity] = useState('');
  const [filterArea, setFilterArea] = useState('');
  
  // 定位狀態
  const [userLocation, setUserLocation] = useState(null);
  const [isWatching, setIsWatching] = useState(true); 
  const [proximityRadius, setProximityRadius] = useState(0.1); 
  
  // 列表收合狀態
  const [isListOpen, setIsListOpen] = useState(true); // 預設改為展開，使用者體驗較佳

  const watchIdRef = useRef(null); 

  // 1. 載入資料
  useEffect(() => {
    const loadData = async () => {
        try {
            const res = await fetch(API_URL);
            if (!res.ok) throw new Error('API Error');
            const raw = await res.json();
            const flattened = flattenStoreData(raw);
            setAllStores(flattened);
            setLoading(false);
            setError('');
        } catch (err) {
            console.error('API 載入錯誤:', err);
            setError('無法載入店家資料，請檢查 API 來源是否正常。');
            setLoading(false);
        }
    };
    loadData();
  }, []);
  
  // 找出距離最近的店家所屬的縣市和區域
  const findNearestStoreLocation = useCallback((location) => {
    if (!location || allStores.length === 0) {
        return { city: DEFAULT_CITY, area: DEFAULT_AREA }; 
    }

    let nearestStore = null;
    let minDistance = Infinity;

    for (const store of allStores) {
        if (store.lat && store.lng) {
            const distance = getDistance(location.lat, location.lng, store.lat, store.lng);
            if (distance < minDistance) {
                minDistance = distance;
                nearestStore = store;
            }
        }
    }
    
    return nearestStore ? { city: nearestStore.city, area: nearestStore.area } : { city: DEFAULT_CITY, area: DEFAULT_AREA }; 
  }, [allStores]);

  // 2. 啟動位置追蹤
  const startWatchingPosition = useCallback(() => {
    if (watchIdRef.current !== null) return;

    if (!navigator.geolocation) {
        setError('您的瀏覽器不支持地理位置追蹤。');
        return;
    }

    // 啟動追蹤時，將靜態篩選重置，並清除選中的店家
    setFilterCity(''); 
    setFilterArea('');
    setSelectedStore(null);
    setIsWatching(true);
    setError('');

    const successHandler = (position) => {
        const newLocation = {
            lat: position.coords.latitude,
            lng: position.coords.longitude
        };
        setUserLocation(newLocation);
    };

    const errorHandler = (err) => {
        console.error('位置追蹤錯誤:', err);
        setError('無法獲取您的位置，請檢查地理位置權限或網路。');
        
        if (watchIdRef.current) {
             navigator.geolocation.clearWatch(watchIdRef.current);
             watchIdRef.current = null;
        }
        setIsWatching(false); 
        // 定位失敗時，自動切換到靜態模式並使用預設城市
        const { city, area } = findNearestStoreLocation(null);
        setFilterCity(city);
        setFilterArea(area);
    };

    watchIdRef.current = navigator.geolocation.watchPosition(
        successHandler,
        errorHandler,
        { 
            enableHighAccuracy: true, 
            timeout: 10000,           
            maximumAge: 0             
        }
    );
  }, [findNearestStoreLocation]); 

  // 3. 停止位置追蹤 (切換到靜態模式)
  const stopWatchingPosition = useCallback(() => {
      if (watchIdRef.current !== null) {
          navigator.geolocation.clearWatch(watchIdRef.current);
          watchIdRef.current = null;
      }
      setIsWatching(false);

      // 根據最後位置找到最近的城市和區域來設定篩選器
      const { city, area } = findNearestStoreLocation(userLocation);
      
      setFilterCity(city);
      setFilterArea(area);

      // 清除 userLocation，讓地圖切換回靜態模式，並清除選中的店家
      setUserLocation(null); 
      setSelectedStore(null);
  }, [findNearestStoreLocation, userLocation]); 

  // 4. 組件掛載時自動開始追蹤 (如果預設開啟)
  useEffect(() => {
    if (isWatching) {
        startWatchingPosition(); 
    }
    
    // 清理函數
    return () => {
        if (watchIdRef.current !== null) {
            navigator.geolocation.clearWatch(watchIdRef.current);
            watchIdRef.current = null;
        }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); 

  // 5. 核心篩選與排序邏輯
  useEffect(() => {
    let results = [...allStores];

    // 實時追蹤模式
    if (userLocation && isWatching) {
        results = allStores.map(store => ({
            ...store,
            distance: getDistance(userLocation.lat, userLocation.lng, store.lat, store.lng)
        }))
        .filter(store => store.distance <= proximityRadius) 
        .sort((a, b) => a.distance - b.distance); 
        
    } else {
        // 靜態模式
        if (filterCity) results = results.filter(s => s.city === filterCity);
        if (filterArea) results = results.filter(s => s.area === filterArea);
        
        // 靜態模式：確保距離資訊被清除
         results = results.map(store => {
            const { distance, ...rest } = store;
            return rest;
        });
    }

    setFilteredStores(results);
  }, [allStores, filterCity, filterArea, userLocation, proximityRadius, isWatching]);


  // 產生縣市和區域的下拉選單選項
  const cities = useMemo(() => [...new Set(allStores.map(s => s.city))].filter(Boolean).sort(), [allStores]);
  const areas = useMemo(() => {
      if (!filterCity) return [];
      return [...new Set(allStores.filter(s => s.city === filterCity).map(s => s.area))].filter(Boolean).sort();
  }, [allStores, filterCity]);


  // 決定地圖中心點和縮放級別
  const mapCenter = useMemo(() => {
      // 1. 追蹤模式：使用使用者位置
      if (userLocation) {
          return { lat: userLocation.lat, lng: userLocation.lng, zoom: MAX_ZOOM };
      }

      // 2. 靜態模式：計算篩選後店家的中心點
      if (filteredStores.length > 0) {
          let totalLat = 0;
          let totalLng = 0;
          
          filteredStores.forEach(store => {
              totalLat += store.lat;
              totalLng += store.lng;
          });
          const avgLat = totalLat / filteredStores.length;
          const avgLng = totalLng / filteredStores.length;

          return { 
              lat: avgLat, 
              lng: avgLng, 
              zoom: DEFAULT_STATIC_ZOOM 
          };
      }

      // 3. 最終回退：使用預設值
      return { 
          lat: DEFAULT_STATIC_LAT, 
          lng: DEFAULT_STATIC_LNG, 
          zoom: DEFAULT_STATIC_ZOOM 
      };
  }, [userLocation, filteredStores]); 

  return (
    // 使用 h-screen 確保內容垂直排列並佔滿整個視窗高度
    <div className="flex flex-col h-screen bg-gray-50 font-sans">
        {/* 地圖區 - 使用 flex-grow 佔滿剩餘空間 */}
        <div className="flex-grow relative z-0 shadow-lg min-h-[50vh]">
            <LeafletMap 
                centerLat={mapCenter.lat}
                centerLng={mapCenter.lng}
                zoom={mapCenter.zoom}
                userLocation={userLocation}
                stores={filteredStores}
                selectedStore={selectedStore}
                onStoreSelect={setSelectedStore}
                proximityRadius={proximityRadius} 
            />
            
            {/* 浮動控制面板 (定位按鈕) - 位於右下角 */}
            <div className="absolute bottom-4 right-4 z-[1000] flex flex-col gap-2">
                <button 
                    onClick={isWatching ? stopWatchingPosition : startWatchingPosition}
                    className={`p-3 rounded-full shadow-xl transition-all flex items-center justify-center ${
                        isWatching 
                            ? 'bg-red-500 hover:bg-red-600 text-white' 
                            : 'bg-white hover:bg-gray-100 text-blue-600 border-2 border-blue-600'
                    } text-lg`}
                    title={isWatching ? "點擊停止實時追蹤" : "點擊開始實時追蹤"}
                >
                    {/* 更新圖標以更清晰表達 "追蹤中" / "停止追蹤" */}
                    {isWatching ? (
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                    ) : (
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                        </svg>
                    )}
                </button>
            </div>
            {error && (
                <div className="absolute top-4 left-4 right-4 md:left-auto md:right-4 z-[1000] bg-red-100 border border-red-400 text-red-700 px-4 py-2 rounded shadow-lg text-sm max-w-sm">
                    {error}
                </div>
            )}
        </div>

        {/* 列表區 - 根據 isListOpen 動態調整高度 */}
        <div 
            className={`bg-white shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.1)] z-10 flex flex-col transition-all duration-300 ease-in-out flex-shrink-0
                ${isListOpen ? 'h-[50vh] md:h-[40vh]' : 'h-14'}
            `}
        >
            {/* 1. Header (可點擊收合/展開) */}
            <div 
                className="flex-shrink-0 p-3 border-b bg-gray-50 flex justify-between items-center cursor-pointer select-none" 
                onClick={() => setIsListOpen(!isListOpen)}
            >
                <h3 className="font-bold text-lg text-gray-700">
                    {isWatching && userLocation ? '附近店家 (依距離排序)' : '靜態店家列表'}
                    <span className="ml-2 text-sm font-normal text-gray-500">
                        (顯示 {filteredStores.length} 間)
                    </span>
                </h3>
                {/* Toggle button/icon */}
                <button 
                    className="p-1 rounded-full text-gray-500 hover:text-gray-700 transition"
                    title={isListOpen ? "收合列表" : "展開列表"}
                >
                    <svg xmlns="http://www.w3.org/2000/svg" className={`h-6 w-6 transform transition-transform ${isListOpen ? 'rotate-180' : 'rotate-0'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
                    </svg>
                </button>
            </div>

            {/* 2. Content (僅在展開時顯示) */}
            <div className={`flex-1 overflow-y-auto ${isListOpen ? 'block' : 'hidden'}`}>
                {/* Control 列 (Filters and Status) */}
                <div className="flex-shrink-0 p-4 border-b bg-white flex flex-col md:flex-row gap-2 items-start md:items-center">
                    <div className="flex gap-2 flex-wrap flex-grow">
                        {/* 縣市篩選器 */}
                        <select 
                            className="p-2 border rounded text-sm w-full md:w-auto"
                            value={filterCity}
                            onChange={(e) => { setFilterCity(e.target.value); setFilterArea(''); }}
                            title="選擇縣市"
                            disabled={isWatching}
                        >
                            <option value="">所有縣市</option>
                            {cities.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                        
                        {/* 區域篩選器 */}
                        {filterCity && (
                            <select 
                                className="p-2 border rounded text-sm w-full md:w-auto"
                                value={filterArea}
                                onChange={(e) => setFilterArea(e.target.value)}
                                title="選擇區域"
                                disabled={isWatching}
                            >
                                <option value="">所有區域</option>
                                {areas.map(a => <option key={a} value={a}>{a}</option>)}
                            </select>
                        )}

                        {/* 半徑篩選器 (僅在追蹤模式下顯示) */}
                        {isWatching && userLocation && (
                            <select
                                className="p-2 border border-green-300 bg-green-50 rounded text-sm text-green-800 font-medium w-full md:w-auto"
                                value={proximityRadius}
                                onChange={(e) => setProximityRadius(Number(e.target.value))}
                                title="選擇附近店家搜索半徑"
                            >
                                <option value="0.1">100 公尺 內</option> 
                                <option value="0.2">200 公尺 內</option> 
                                <option value="0.5">500 公尺 內</option>
                                <option value="1">1 km 內</option>
                                <option value="3">3 km 內</option>
                                <option value="5">5 km 內</option>
                                <option value="10">10 km 內</option>
                            </select>
                        )}
                    </div>
                    
                    <div className="text-sm text-gray-500 flex-shrink-0 mt-2 md:mt-0">
                        模式：
                        <span className={`font-bold ml-1 ${isWatching && userLocation ? 'text-red-600' : 'text-blue-600'}`}>
                            {isWatching && userLocation ? '實時追蹤中' : '靜態篩選中'}
                        </span>
                    </div>
                </div>

                {/* 店家列表 (Scrollable content) */}
                <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-gray-100">
                    {loading ? (
                        <div className="text-center py-10 text-gray-500 flex items-center justify-center">
                            <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-gray-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                            </svg>
                            店家資料載入中...
                        </div>
                    ) : filteredStores.length === 0 ? (
                        <div className="text-center py-10 text-gray-500 p-4 border border-dashed border-gray-300 rounded-lg">
                            <svg xmlns="http://www.w3.org/2000/svg" className="mx-auto h-8 w-8 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                            </svg>
                            <p className="mt-2 text-sm font-medium">
                                {isWatching && userLocation ? '附近沒有找到店家，試試擴大範圍。' : '未找到符合條件的店家。'}
                            </p>
                            {(!isWatching && filterCity === '' && filterArea === '') && (
                                <p className="mt-1 text-xs text-red-500">請先選擇縣市和區域，或點擊右下角按鈕開啟定位追蹤。</p>
                            )}
                        </div>
                    ) : (
                        filteredStores.map(store => (
                            <div 
                                key={store.id}
                                onClick={() => setSelectedStore(store)}
                                className={`p-4 bg-white rounded-lg shadow-sm border-l-4 cursor-pointer transition-all hover:shadow-md flex justify-between items-center
                                    ${selectedStore?.id === store.id ? 'border-blue-500 ring-2 ring-blue-300' : 'border-gray-200 hover:border-blue-300'}
                                `}
                            >
                                <div>
                                    <h4 className="font-bold text-gray-800">{store.name}</h4>
                                    <p className="text-xs text-gray-500 mt-0.5">{store.address}</p>
                                </div>
                                {/* 距離顯示 (只在追蹤模式下顯示) */}
                                {store.distance !== undefined && (() => { 
                                    const isMeters = store.distance < 1;
                                    const value = isMeters ? (store.distance * 1000).toFixed(0) : store.distance.toFixed(1);
                                    const unit = isMeters ? '公尺' : 'km';
                                    return (
                                        <div className="text-right flex-shrink-0 ml-4">
                                            <span className="block text-lg font-extrabold text-green-600 leading-none">{value}</span>
                                            <span className="text-[10px] text-gray-500">{unit}</span>
                                        </div>
                                    );
                                })()}
                            </div>
                        ))
                    )}
                </div>
            </div>
        </div>
    </div>
  );
};

// 使用 React 18 風格的 createRoot
const rootElement = document.getElementById('root');
if (rootElement) {
    const root = createRoot(rootElement);
    root.render(<App />);
}