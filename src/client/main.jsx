import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { createRoot } from 'react-dom/client';

// 移除 import.meta.env.DEV 判斷式，直接使用外部 API 網址，以避免環境變數錯誤。
const API_URL = 'https://patrol-master.onrender.com/api/stores';

// 台灣中心點 (預設地圖位置)
const TAIWAN_CENTER_LAT = 23.6978;
const TAIWAN_CENTER_LNG = 120.9605;

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
// 新增 proximityRadius 屬性
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
        zoomControl: false // 禁用預設縮放控制
    }).setView([centerLat, centerLng], zoom);
    
    // 使用 OpenStreetMap 圖層
    window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);

    // 添加縮放控制在右上角
    window.L.control.zoom({ position: 'topright' }).addTo(map);

    mapInstanceRef.current = map;
    // 延遲刷新地圖，避免因容器大小未定而產生灰色區塊
    setTimeout(() => map.invalidateSize(), 100); 

  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLeafletLoaded]); // 移除 centerLat, centerLng, zoom 避免地圖不必要的重建

  // 3. 繪製標記 (Markers)
  useEffect(() => {
    if (!mapInstanceRef.current || !isLeafletLoaded) return;

    const map = mapInstanceRef.current;
    const L = window.L;

    // 清除舊店家標記 (保留使用者標記)
    markersRef.current.forEach(marker => marker.remove());
    markersRef.current = [];

    // 標記的 SVG 圖標生成器
    const createIcon = (color, size = 25) => {
        const svg = `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="${color}" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path>
          <circle cx="12" cy="10" r="3"></circle>
        </svg>`;
        return L.divIcon({
            className: 'custom-icon',
            html: svg,
            iconSize: [size, size],
            iconAnchor: [size / 2, size],
            popupAnchor: [0, -size]
        });
    };

    const userIcon = createIcon('#3b82f6', 35); // 藍色 (使用者)
    const storeIcon = createIcon('#ef4444', 30); // 紅色 (店家)
    const selectedIcon = createIcon('#fbbf24', 40); // 黃色 (選中)

    // A. 更新或標記使用者位置和半徑圈
    if (userLocation) {
        const latLng = [userLocation.lat, userLocation.lng];
        
        // 1. 更新使用者標記
        if (!userMarkerRef.current) {
             // 首次建立使用者標記
             userMarkerRef.current = L.marker(latLng, { icon: userIcon, zIndexOffset: 500 })
                .addTo(map)
                .bindPopup(`<b>📍 您的位置</b>`)
                .openPopup();
        } else {
             // 更新使用者標記位置
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
                zIndexOffset: 400 // 在標記下方
            }).addTo(map);
        } else {
            userCircleRef.current.setLatLng(latLng).setRadius(radiusInMeters);
        }

        // 3. 判斷是否需要移動地圖或調整縮放
        let currentZoom = map.getZoom();
        let targetZoom = currentZoom;
        
        // 如果半徑小於等於 1km，強制放大到 17 級 (100m 顯示效果較佳)
        if (proximityRadius <= 1) {
            targetZoom = 17;
        } else if (currentZoom < 14) {
            targetZoom = 14;
        }

        // 只有當地圖中心與使用者位置差異過大，或者縮放級別需要調整時才移動
        if (map.getCenter().distanceTo(latLng) > 500 || targetZoom !== currentZoom) {
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


      const marker = L.marker([store.lat, store.lng], { 
          icon: isSelected ? selectedIcon : storeIcon,
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
    if (!userLocation && !selectedStore) {
        // 靜態模式：居中台灣
        map.flyTo([centerLat, centerLng], zoom);
    } else if (selectedStore) {
        // 鎖定選中的店家
        map.flyTo([selectedStore.lat, selectedStore.lng], 16);
    } 

  }, [isLeafletLoaded, userLocation, stores, selectedStore, onStoreSelect, centerLat, centerLng, zoom, proximityRadius]); // 新增 proximityRadius 依賴

  return <div ref={mapRef} className="h-full w-full bg-gray-100 rounded-lg" />;
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
  const [isWatching, setIsWatching] = useState(true); // 預設開啟實時追蹤
  // *** 變更：預設半徑調整為 100 公尺 (0.1 km) ***
  const [proximityRadius, setProximityRadius] = useState(0.1); // 搜索半徑 (預設 100公尺)
  
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

  // 2. 啟動/停止位置追蹤
  const startWatchingPosition = useCallback(() => {
    // 檢查是否已經有追蹤 ID，若有則避免重複啟動
    if (watchIdRef.current !== null) return;

    if (!navigator.geolocation) {
        setError('您的瀏覽器不支持地理位置追蹤。');
        return;
    }

    // 啟動追蹤時，將 isWatching 設為 true (用於 UI 狀態)
    setIsWatching(true);
    setError('');

    const successHandler = (position) => {
        const newLocation = {
            lat: position.coords.latitude,
            lng: position.coords.longitude
        };
        // 每次成功獲取新位置，就更新狀態
        setUserLocation(newLocation);
    };

    const errorHandler = (err) => {
        console.error('位置追蹤錯誤:', err);
        // 在追蹤失敗時顯示錯誤訊息
        setError('無法獲取您的位置，請檢查地理位置權限或網路。');
        
        // 追蹤失敗，應停止追蹤
        if (watchIdRef.current) {
             navigator.geolocation.clearWatch(watchIdRef.current);
             watchIdRef.current = null;
        }
        setIsWatching(false); // 追蹤失敗，將狀態設回 false
    };

    // 啟動持續監聽，這就是實時追蹤的關鍵
    watchIdRef.current = navigator.geolocation.watchPosition(
        successHandler,
        errorHandler,
        { 
            enableHighAccuracy: true, // 啟用高精度模式
            timeout: 10000,           // 等待位置的時間 (10秒)
            maximumAge: 0             // 不使用緩存，強制獲取最新位置
        }
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // 移除 isWatching 依賴，使用 watchIdRef 進行防重複

  const stopWatchingPosition = useCallback(() => {
      if (watchIdRef.current !== null) {
          navigator.geolocation.clearWatch(watchIdRef.current);
          watchIdRef.current = null;
      }
      setIsWatching(false);
      setUserLocation(null);
      setSelectedStore(null);
  }, []); // 無需依賴

  // 3. 組件掛載時自動開始追蹤，卸載時停止
  useEffect(() => {
    // 預設開啟追蹤 (startWatchingPosition 會檢查 watchIdRef.current)
    startWatchingPosition(); 
    
    // 清理函數：在組件卸載時自動停止追蹤
    return () => {
        // 在組件卸載時執行 stopWatchingPosition 確保清理
        if (watchIdRef.current !== null) {
            navigator.geolocation.clearWatch(watchIdRef.current);
            watchIdRef.current = null;
        }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // 僅在組件生命週期內執行一次

  // 4. 核心篩選與排序邏輯：當位置、半徑或靜態篩選條件改變時更新店家列表
  useEffect(() => {
    let results = [...allStores];

    // 1. 靜態篩選 (縣市/區域) - 在任何模式下都生效
    if (filterCity) results = results.filter(s => s.city === filterCity);
    if (filterArea) results = results.filter(s => s.area === filterArea);

    // 2. 實時追蹤模式下的距離計算、篩選和排序
    if (userLocation && isWatching) {
        results = results.map(store => ({
            ...store,
            // 計算距離
            distance: getDistance(userLocation.lat, userLocation.lng, store.lat, store.lng)
        }))
        .filter(store => store.distance <= proximityRadius) // 只保留在設定半徑內的店家
        .sort((a, b) => a.distance - b.distance); // 由近到遠排序
    } else {
        // 如果不在追蹤模式，確保距離資訊被清除
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
      return [...new Set(allStores.filter(s => s.city === filterCity).map(s => s.area))].filter(Boolean).sort();
  }, [allStores, filterCity]);


  // 決定地圖中心點和縮放級別
  const mapCenter = useMemo(() => {
      return { 
          lat: userLocation?.lat || TAIWAN_CENTER_LAT, 
          lng: userLocation?.lng || TAIWAN_CENTER_LNG, 
          zoom: userLocation ? 14 : 8 // 有位置時放大，否則顯示全台灣
      };
  }, [userLocation]);

  return (
    <div className="flex flex-col h-screen bg-gray-50 font-sans">
        {/* 地圖區 */}
        <div className="flex-1 relative z-0 shadow-lg">
            <LeafletMap 
                centerLat={mapCenter.lat}
                centerLng={mapCenter.lng}
                zoom={mapCenter.zoom}
                userLocation={userLocation}
                stores={filteredStores}
                selectedStore={selectedStore}
                onStoreSelect={setSelectedStore}
                proximityRadius={proximityRadius} // 傳遞半徑給地圖元件
            />
            
            {/* 浮動控制面板 (定位按鈕) - 位於右下角 */}
            <div className="absolute bottom-4 right-4 z-[1000] flex flex-col gap-2">
                <button 
                    // 根據 isWatching 狀態決定呼叫停止或啟動
                    onClick={isWatching ? stopWatchingPosition : startWatchingPosition}
                    className={`p-3 rounded-full shadow-xl transition-all flex items-center justify-center ${
                        isWatching 
                            ? 'bg-red-500 hover:bg-red-600 text-white' 
                            : 'bg-white hover:bg-gray-100 text-blue-600'
                    }`}
                    title={isWatching ? "點擊停止實時追蹤" : "點擊開始實時追蹤"}
                >
                    {isWatching ? (
                        // 正在追蹤中的圖標 (脈衝波)
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 animate-pulse" viewBox="0 0 20 20" fill="currentColor">
                          <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM6.707 9.293a1 1 0 00-1.414 1.414l3 3a1 1 0 001.414 0l5-5a1 1 0 10-1.414-1.414L9 11.586l-2.293-2.293z" clipRule="evenodd" />
                        </svg>
                    ) : (
                        // 停止追蹤時的圖標
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
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

        {/* 列表區 */}
        <div className="h-2/5 bg-white shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.1)] z-10 flex flex-col">
            {/* 控制列 */}
            <div className="p-4 border-b bg-gray-50 flex flex-wrap gap-2 items-center">
                <div className="flex gap-2 flex-grow">
                    {/* 縣市篩選器 (現在總是顯示) */}
                    <select 
                        className="p-2 border rounded text-sm"
                        value={filterCity}
                        onChange={(e) => { setFilterCity(e.target.value); setFilterArea(''); }}
                        title="選擇縣市"
                    >
                        <option value="">所有縣市</option>
                        {cities.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                    
                    {/* 區域篩選器 (現在總是顯示) */}
                    {filterCity && (
                        <select 
                            className="p-2 border rounded text-sm"
                            value={filterArea}
                            onChange={(e) => setFilterArea(e.target.value)}
                            title="選擇區域"
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
                            {/* *** 更改為 100 公尺選項 (0.1 km) 並設為預設 *** */}
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

            {/* 店家列表 */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-gray-100">
                {loading ? (
                    <div className="text-center py-10 text-gray-500">店家資料載入中...</div>
                ) : filteredStores.length === 0 ? (
                    <div className="text-center py-10 text-gray-500">
                        {isWatching && userLocation ? '附近沒有找到店家，試試擴大範圍或停止追蹤切換篩選模式。' : '未找到符合條件的店家。'}
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
  );
};

// 使用 React 18 風格的 createRoot
const rootElement = document.getElementById('root');
if (rootElement) {
    const root = createRoot(rootElement);
    root.render(<App />);
}