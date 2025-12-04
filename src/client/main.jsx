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
const DEFAULT_STATIC_ZOOM = 16;


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
  const userMarkerRef = useRef(null); // 用於儲存使用者標記實例
  const userCircleRef = useRef(null); // 用於儲存半徑圈實例
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
  }, []);

  // 2. 初始化地圖
  useEffect(() => {
    if (!isLeafletLoaded || !mapRef.current || mapInstanceRef.current) return;

    const map = window.L.map(mapRef.current, {
        zoomControl: false, // 禁用預設縮放控制
        maxZoom: MAX_ZOOM, // 設定最大縮放級別
    }).setView([centerLat, centerLng], zoom);
    
    // 使用 OpenStreetMap 圖層
    window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: MAX_ZOOM, // 確保底圖也能放大到設定的最大級別
    }).addTo(map);

    // 添加縮放控制在右上角
    window.L.control.zoom({ position: 'topright' }).addTo(map);

    mapInstanceRef.current = map;
    // 延遲刷新地圖，避免因容器大小未定而產生灰色區塊
    setTimeout(() => map.invalidateSize(), 100); 

  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLeafletLoaded]); 

  // 3. 處理容器大小變化 (列表收合/展開)
  useEffect(() => {
    if (!mapInstanceRef.current || !isLeafletLoaded) return;

    const map = mapInstanceRef.current;
    
    // 每次地圖容器大小變化時，強制 Leaflet 重新計算尺寸
    const resizeObserver = new ResizeObserver(() => {
        if (mapInstanceRef.current) {
            mapInstanceRef.current.invalidateSize({ pan: false });
        }
    });

    if (mapRef.current) {
        resizeObserver.observe(mapRef.current);
    }
    
    // 清理函數：在元件卸載或依賴項改變前停止觀察
    return () => {
        resizeObserver.disconnect();
    };

  }, [isLeafletLoaded]); 

  // 4. 繪製和更新標記/定位邏輯
  useEffect(() => {
    if (!mapInstanceRef.current || !isLeafletLoaded) return;

    const map = mapInstanceRef.current;
    const L = window.L;

    // 清除舊店家標記 (保留使用者標記)
    markersRef.current.forEach(marker => marker.remove());
    markersRef.current = [];

    // 1. 娃娃機店標記的 SVG 圖標生成器
    const createStoreIcon = (color, size = 30, text = '') => {
        
        // 店家名稱標籤 (使用行內 CSS 確保樣式正確顯示)
        const textHtml = text ? `
            <div style="
                position: absolute; 
                top: -${size * 0.9}px; /* 向上調整位置 */
                left: 50%; 
                transform: translateX(-50%);
                padding: 4px 8px; /* 增加內邊距 */
                background: ${color}; 
                color: white; 
                font-size: 14px; /* 字體大小 */
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

        // 結合標籤和標記
        const htmlContent = `
            ${textHtml}
            ${svg}
        `;

        const markerSize = size;
        
        return L.divIcon({
            className: 'custom-store-icon',
            html: htmlContent,
            iconSize: [markerSize, markerSize],
            iconAnchor: [markerSize / 2, markerSize],
            popupAnchor: [0, -markerSize]
        });
    };

    // 2. 使用者標記的 SVG 圖標生成器
    const createUserIcon = (size = 30) => {
        const customStyles = `
            <style>
                @keyframes bobbing {
                    0%, 100% { transform: translateY(0); }
                    50% { transform: translateY(-4px); } /* 上移 4px */
                }
                .walking-bob {
                    animation: bobbing 1.5s ease-in-out infinite;
                }
            </style>
        `;

        const walkingStickFigureSvg = `
            <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <!-- 頭部 -->
                <circle cx="12" cy="4" r="1.5" fill="#3b82f6" stroke="none"/> 
                <!-- 身體 -->
                <path d="M12 5.5v8"/> 
                <!-- 手部 (模擬擺動) -->
                <path d="M9 10l-2 2"/> 
                <path d="M15 10l2 2"/> 
                <!-- 腿部 (模擬走路) -->
                <path d="M12 13.5l-3 5"/> 
                <path d="M12 13.5l3 4"/> 
            </svg>
        `;

        const walkingSvg = `
        ${customStyles}
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
    if (userLocation) {
        const latLng = [userLocation.lat, userLocation.lng];
        
        // 1. 更新使用者標記
        if (!userMarkerRef.current) {
             userMarkerRef.current = L.marker(latLng, { icon: userIcon, zIndexOffset: 500 })
                .addTo(map)
                .bindPopup(`<b>🚶 您的位置</b>`)
                .openPopup();
        } else {
             userMarkerRef.current.setLatLng(latLng);
        }

        // 2. 更新半徑圈 (將 km 轉為 meter)
        const radiusInMeters = proximityRadius * 1000;
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

        // 3. 判斷是否需要移動地圖或調整縮放
        let targetZoom = MAX_ZOOM; 

        // 只有在未選中店家時，才根據追蹤邏輯移動視圖
        if (!selectedStore) {
            map.flyTo(latLng, targetZoom);
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

      // 距離顯示邏輯 (地圖彈出視窗)
      let distanceHtml = '';
      if (store.distance !== undefined) {
          const isMeters = store.distance < 1;
          const value = isMeters ? (store.distance * 1000).toFixed(0) : store.distance.toFixed(1);
          const unit = isMeters ? '公尺' : 'km';
          distanceHtml = `<span class="text-green-600 font-bold">${value} ${unit}</span><br/>`;
      }

      // 關鍵異動：根據是否選中，決定是否傳入店名給 icon 生成器
      const icon = isSelected 
          ? createStoreIcon('#fbbf24', 40, '') // 黃色標記 (已選中)，不顯示名稱
          : createStoreIcon('#ef4444', 30, store.name); // 紅色標記 (未選中)，顯示名稱

      const marker = L.marker([store.lat, store.lng], { 
          icon: icon, // 使用動態生成的 icon
          zIndexOffset: isSelected ? 1000 : 0 // 選中的圖標層級最高
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
        // *** 鎖定選中的店家並使用 MAX_ZOOM (18) ***
        map.flyTo([selectedStore.lat, selectedStore.lng], MAX_ZOOM);
    } else if (!userLocation) {
        // 靜態模式：居中預設的信義區中心
        map.flyTo([centerLat, centerLng], DEFAULT_STATIC_ZOOM);
    } 

  }, [isLeafletLoaded, userLocation, stores, selectedStore, onStoreSelect, centerLat, centerLng, proximityRadius]); 

  return <div ref={mapRef} className="h-full w-full bg-gray-100 rounded-lg" />;
};

// --- 主要 App 邏輯 ---

const App = () => {
  const [allStores, setAllStores] = useState([]);
  const [filteredStores, setFilteredStores] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedStore, setSelectedStore] = useState(null);
  
  // 篩選狀態：預設空字串，因為啟動時是追蹤模式 (會被覆蓋)
  const [filterCity, setFilterCity] = useState('');
  const [filterArea, setFilterArea] = useState('');
  
  // 定位狀態
  const [userLocation, setUserLocation] = useState(null);
  // 預設開啟實時追蹤
  const [isWatching, setIsWatching] = useState(true); 
  // 預設搜索半徑為 0.1 km (100 公尺)
  const [proximityRadius, setProximityRadius] = useState(0.1); 
  
  // 控制列表是否展開 (預設收合列表)
  const [isListOpen, setIsListOpen] = useState(false); 

  const watchIdRef = useRef(null); // 儲存 watchPosition 的 ID，用於清理

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
            console.error(err);
            setError('無法載入店家資料，請檢查 API 來源是否正常。');
            setLoading(false);
        }
    };
    loadData();
  }, []);
  
  // 找出距離最近的店家所屬的縣市和區域
  const findLocationBasedOnStores = useCallback((location) => {
    if (!location || allStores.length === 0) {
        // 沒有定位資訊或資料，回退到預設
        return { city: DEFAULT_CITY, area: DEFAULT_AREA }; 
    }

    let nearestStore = null;
    let minDistance = Infinity;

    // 尋找整個資料集中距離使用者位置最近的店家
    for (const store of allStores) {
        if (store.lat && store.lng) {
            const distance = getDistance(location.lat, location.lng, store.lat, store.lng);
            if (distance < minDistance) {
                minDistance = distance;
                nearestStore = store;
            }
        }
    }
    
    if (nearestStore) {
        return { city: nearestStore.city, area: nearestStore.area };
    } else {
        // 找不到任何店家，回退到預設
        return { city: DEFAULT_CITY, area: DEFAULT_AREA }; 
    }
  }, [allStores]);

  // 2. 啟動位置追蹤
  const startWatchingPosition = useCallback(() => {
    if (watchIdRef.current !== null) return;

    if (!navigator.geolocation) {
        setError('您的瀏覽器不支持地理位置追蹤。');
        return;
    }

    // 啟動追蹤時，將靜態篩選重置
    setFilterCity(''); 
    setFilterArea('');
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
        setFilterCity(DEFAULT_CITY);
        setFilterArea(DEFAULT_AREA);
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); 

  // 3. 停止位置追蹤 (切換到靜態模式)
  const stopWatchingPosition = useCallback(() => {
      if (watchIdRef.current !== null) {
          navigator.geolocation.clearWatch(watchIdRef.current);
          watchIdRef.current = null;
      }
      setIsWatching(false);

      // 根據最後位置找到最近的城市和區域來設定篩選器
      const { city, area } = findLocationBasedOnStores(userLocation);
      
      setFilterCity(city);
      setFilterArea(area);

      // 清除 userLocation，讓地圖切換回靜態模式
      setUserLocation(null); 
      setSelectedStore(null);
  }, [findLocationBasedOnStores, userLocation]); 

  // 4. 組件掛載時自動開始追蹤
  useEffect(() => {
    // 只有在 isWatching 預設為 true 時才啟動 (預防二次啟動)
    if (isWatching) {
        startWatchingPosition(); 
    }
    
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

    // 實時追蹤模式下的距離計算、篩選和排序
    if (userLocation && isWatching) {
        // 追蹤模式：不理會篩選條件，只顯示附近店家
        results = allStores.map(store => ({
            ...store,
            // 計算距離
            distance: getDistance(userLocation.lat, userLocation.lng, store.lat, store.lng)
        }))
        .filter(store => store.distance <= proximityRadius) // 只保留在設定半徑內的店家
        .sort((a, b) => a.distance - b.distance); // 由近到遠排序
        
    } else {
        // 靜態模式：使用縣市/區域篩選
        if (filterCity) results = results.filter(s => s.city === filterCity);
        if (filterArea) results = results.filter(s => s.area === filterArea);
        
        // 靜態模式：確保距離資訊被清除
         results = results.map(store => {
            if (store.distance !== undefined) {
                const { distance, ...rest } = store;
                return rest;
            }
            return store;
        });
    }

    setFilteredStores(results);
  }, [allStores, filterCity, filterArea, userLocation, proximityRadius, isWatching]);


  // 產生縣市和區域的下拉選單選項
  const cities = useMemo(() => [...new Set(allStores.map(s => s.city))].filter(Boolean).sort(), [allStores]);
  const areas = useMemo(() => {
      if (!filterCity) return [];
      // 注意：這裡必須使用 allStores 來確保我們能找到所有區域
      return [...new Set(allStores.filter(s => s.city === filterCity).map(s => s.area))].filter(Boolean).sort();
  }, [allStores, filterCity]);


  // 決定地圖中心點和縮放級別
  const mapCenter = useMemo(() => {
      // 1. 追蹤模式：使用使用者位置
      if (userLocation) {
          return { lat: userLocation.lat, lng: userLocation.lng, zoom: MAX_ZOOM };
      }

      // 2. 靜態模式：如果篩選後有店家，則計算這些店家的中心點 (修正重點！)
      if (filteredStores.length > 0) {
          let totalLat = 0;
          let totalLng = 0;
          // 計算所有篩選店家的平均經緯度
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

      // 3. 最終回退：如果沒有定位資訊，也沒有篩選結果，則使用預設值
      return { 
          lat: DEFAULT_STATIC_LAT, 
          lng: DEFAULT_STATIC_LNG, 
          zoom: DEFAULT_STATIC_ZOOM 
      };
      // 關鍵：將 filteredStores 加入依賴項，確保篩選後會重新計算中心點
  }, [userLocation, filteredStores]); 

  return (
    <div className="flex flex-col h-screen bg-gray-50 font-sans">
        {/* 地圖區 - 使用 flex-grow 佔滿剩餘空間 */}
        <div className="flex-grow relative z-0 shadow-lg">
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
                            : 'bg-white hover:bg-gray-100 text-blue-600'
                    }`}
                    title={isWatching ? "點擊停止實時追蹤" : "點擊開始實時追蹤"}
                >
                    {isWatching ? (
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 animate-pulse" viewBox="0 0 20 20" fill="currentColor">
                          <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM6.707 9.293a1 1 0 00-1.414 1.414l3 3a1 1 0 001.414 0l5-5a1 1 0 10-1.414-1.414L9 11.586l-2.293-2.293z" clipRule="evenodd" />
                        </svg>
                    ) : (
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 8 0 1111.314 0z" />
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                        </svg>
                    )}
                </button>
            </div>
            {error && (
                <div className="absolute top-4 left-4 z-[1000] bg-red-100 border border-red-400 text-red-700 px-4 py-2 rounded shadow-lg text-sm">
                    {error}
                </div>
            )}
        </div>

        {/* 列表區 - 根據 isListOpen 動態調整高度 */}
        <div 
            className={`bg-white shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.1)] z-10 flex flex-col transition-all duration-300 ease-in-out ${isListOpen ? 'h-[60vh]' : 'h-14'}`}
        >
            {/* 1. Header (總是可見，用於收合/展開) */}
            <div 
                className="flex-shrink-0 p-3 border-b bg-gray-50 flex justify-between items-center cursor-pointer" 
                onClick={() => setIsListOpen(!isListOpen)}
            >
                <h3 className="font-bold text-lg text-gray-700">
                    {isListOpen ? '收合店家列表' : '展開店家列表 (點擊展開)'}
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
                <div className="flex-shrink-0 p-4 border-b bg-gray-50 flex flex-wrap gap-2 items-center">
                    <div className="flex gap-2 flex-grow">
                        {/* 縣市篩選器 */}
                        <select 
                            className="p-2 border rounded text-sm"
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
                                className="p-2 border rounded text-sm"
                                value={filterArea}
                                onChange={(e) => setFilterArea(e.target.value)}
                                title="選擇區域"
                                disabled={isWatching}
                            >
                                <option value="">所有區域</option>
                                {areas.map(a => <option key={a} value={a}>{a}</option>)}
                            </select>
                        )}

                        {/* 半徑篩選器 (僅在定位模式下顯示) */}
                        {isWatching && userLocation && (
                            <select
                                className="p-2 border border-green-300 bg-green-50 rounded text-sm text-green-800 font-medium"
                                value={proximityRadius}
                                onChange={(e) => setProximityRadius(Number(e.target.value))}
                                title="選擇附近店家搜索半徑"
                            >
                                {/* 調整選項順序，讓 100 公尺預設顯示 */}
                                <option value="0.1">100 公尺 內</option> 
                                <option value="0.2">200 公尺 內</option> 
                                <option value="0.5">500 公尺 內</option>
                                <option value="1">1 km 內</option>
                                <option value="3">3 km 內</option>
                                <option value="5">5 km 內</option>
                                <option value="10">10 km 內</option>
                                <option value="20">20 km 內</option>
                            </select>
                        )}
                    </div>
                    
                    <div className="text-sm text-gray-500 ml-auto">
                        模式：
                        <span className={`font-bold ml-1 ${isWatching && userLocation ? 'text-red-600' : 'text-blue-600'}`}>
                            {isWatching && userLocation ? '實時追蹤中' : '靜態篩選中'}
                        </span>
                        &middot; 顯示: <strong>{filteredStores.length}</strong> 間
                    </div>
                </div>

                {/* 店家列表 (Scrollable content) */}
                <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-gray-100">
                    {loading ? (
                        <div className="text-center py-10 text-gray-500">店家資料載入中...</div>
                    ) : filteredStores.length === 0 ? (
                        <div className="text-center py-10 text-gray-500">
                            {isWatching && userLocation ? '附近沒有找到店家，試試擴大範圍。' : '未找到符合條件的店家。'}
                            {(!isWatching && filterCity === '' && filterArea === '') && (
                                <span className="block mt-2 text-xs text-red-500">請先選擇縣市和區域。</span>
                            )}
                        </div>
                    ) : (
                        filteredStores.map(store => (
                            <div 
                                key={store.id}
                                onClick={() => setSelectedStore(store)}
                                className={`p-3 bg-white rounded-lg shadow-sm border-l-4 cursor-pointer transition-all hover:shadow-md flex justify-between items-center
                                    ${selectedStore?.id === store.id ? 'border-blue-500 ring-1 ring-blue-200' : 'border-transparent'}
                                `}
                            >
                                <div>
                                    <h4 className="font-bold text-gray-800">{store.name}</h4>
                                    <p className="text-xs text-gray-500">{store.address}</p>
                                </div>
                                {/* 根據距離自動切換顯示單位 (公尺/km) */}
                                {store.distance !== undefined && (() => { 
                                    const isMeters = store.distance < 1;
                                    // 如果是公尺，四捨五入到整數；如果是 km，保留一位小數
                                    const value = isMeters ? (store.distance * 1000).toFixed(0) : store.distance.toFixed(1);
                                    const unit = isMeters ? '公尺' : 'km';
                                    return (
                                        <div className="text-right flex-shrink-0 ml-4">
                                            <span className="block text-lg font-bold text-green-600">{value}</span>
                                            <span className="text-[10px] text-gray-400">{unit}</span>
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