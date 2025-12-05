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
const DEFAULT_STATIC_ZOOM = 17;


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
const LeafletMap = ({ centerLat, centerLng, zoom, userLocation, stores, selectedStore, onStoreSelect, proximityRadius, mapControlRef, isWatching, userHeading }) => {
  const mapRef = useRef(null); 
  const mapInstanceRef = useRef(null); 
  const markersRef = useRef([]);
  const userMarkerRef = useRef(null); 
  const userCircleRef = useRef(null); 
  const [isLeafletLoaded, setIsLeafletLoaded] = useState(false);
  
  // 暴露給父元件呼叫的方法：強制地圖重新計算尺寸
  const forceMapResize = useCallback(() => {
    if (mapInstanceRef.current && window.L) {
        window.requestAnimationFrame(() => {
            // 使用 { pan: false } 避免在 resize 時地圖亂跑
            mapInstanceRef.current.invalidateSize({ pan: false });
        });
    }
  }, []);

  // 1. 將 forceMapResize 綁定到傳入的 ref
  useEffect(() => {
      if (mapControlRef) {
          mapControlRef.current = { forceMapResize };
      }
  }, [mapControlRef, forceMapResize]); 

  // 2. 動態載入 Leaflet 資源 (CSS & JS)
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

    // 添加自定義 CSS (動畫)
    const style = document.createElement('style');
    style.innerHTML = `
        @keyframes bobbing {
            0%, 100% { transform: translateY(0); }
            50% { transform: translateY(-4px); } 
        }
        .walking-bob {
            animation: bobbing 1.5s ease-in-out infinite;
        }
        /* 新增：靜態模式下的發光效果 (顏色加深) */
        @keyframes static-glow {
            0% { box-shadow: 0 0 0 0 rgba(0, 68, 255, 0.6); }
            50% { box-shadow: 0 0 0 10px rgba(0, 68, 255, 0.2); }
            100% { box-shadow: 0 0 0 0 rgba(0, 68, 255, 0); }
        }
        .user-icon-static-glow {
            animation: static-glow 2s infinite;
            border-color: #0044FF !important; /* 強制邊框變深藍 */
        }
    `;
    document.head.appendChild(style);

  }, []);

  // 3. 初始化地圖
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
    
    // 初始化時強制刷新一次
    setTimeout(() => map.invalidateSize(), 100); 

  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLeafletLoaded]); 

  // 4. 視圖控制 (flyTo)
  useEffect(() => {
      if (!mapInstanceRef.current || !isLeafletLoaded) return;
      
      const map = mapInstanceRef.current;
      // 使用 flyTo 平滑移動到指定中心點
      map.flyTo([centerLat, centerLng], zoom);
  }, [centerLat, centerLng, zoom, isLeafletLoaded]);

  // 5. 繪製和更新標記/定位邏輯
  useEffect(() => {
    if (!mapInstanceRef.current || !isLeafletLoaded) return;

    const map = mapInstanceRef.current;
    const L = window.L;

    // 清除舊店家標記 
    markersRef.current.forEach(marker => marker.remove());
    markersRef.current = [];

    // 店家圖標生成器 (顏色增強)
    const createStoreIcon = (color, size = 30, text = '', isSelected) => {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="${color}" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>`;

        let textHtml = '';
        if (text) {
             // 確保文字背景顏色也同步變深
             textHtml = `<div style="position: absolute; top: -${size * 0.9}px; left: 50%; transform: translateX(-50%); padding: 4px 8px; background: ${color}; color: white; font-size: 14px; font-weight: 700; border-radius: 9999px; white-space: nowrap; box-shadow: 0 2px 6px rgba(0,0,0,0.5); line-height: 1; z-index: 10;">${text}</div>`;
        }
        
        const htmlContent = textHtml + svg; 

        const markerSize = isSelected ? 45 : size; // 選中時稍微再大一點
        
        return L.divIcon({
            className: 'custom-store-icon',
            html: htmlContent, 
            iconSize: [markerSize, markerSize],
            iconAnchor: [markerSize / 2, markerSize],
            popupAnchor: [0, -markerSize]
        });
    };

    // 使用者圖標生成器 (顏色增強：深藍與深灰)
    const createUserIcon = (size = 30, heading, isTracking) => {
        // 箭頭形狀 SVG
        // *** 顏色調整：使用更鮮豔的 #0044FF (深藍) 和 #555555 (深灰) ***
        const arrowColor = isTracking ? '#0044FF' : '#555555';
        const arrowSvg = `
            <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="${arrowColor}" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 2 L22 22 L12 18 L2 22 Z" />
            </svg>
        `;
        
        const rotationStyle = (heading !== null && heading !== undefined)
            ? `transform: rotate(${heading}deg);` 
            : ''; 

        // 靜態模式下的發光 class
        const glowClass = !isTracking ? 'user-icon-static-glow' : '';
            
        // 外層容器
        const userHtml = `
            <div class="user-icon-div ${glowClass}" style="
                width: ${size + 12}px; 
                height: ${size + 12}px; 
                display: flex; 
                align-items: center; 
                justify-content: center; 
                background: white; 
                border-radius: 50%; 
                box-shadow: 0 3px 8px rgba(0, 0, 0, 0.5); 
                border: 3px solid ${arrowColor}; /* 加粗邊框 */
                transition: transform 0.3s ease-out;
            ">
                <div style="
                    width: ${size}px; 
                    height: ${size}px; 
                    transition: transform 0.3s ease-out; 
                    ${rotationStyle}
                ">
                    ${arrowSvg}
                </div>
            </div>`;

        return L.divIcon({
            className: 'user-icon-container',
            html: userHtml,
            iconSize: [size + 12, size + 12], 
            iconAnchor: [(size + 12) / 2, (size + 12) / 2], // 中心錨點
            popupAnchor: [0, -size/2]
        });
    };


    // A. 更新或標記使用者位置和半徑圈
    if (userLocation) {
        const latLng = [userLocation.lat, userLocation.lng];
        
        // 1. 產生帶有方向的圖標
        const currentIcon = createUserIcon(30, userHeading, isWatching);
        
        // 建立 Popup 內容
        let popupContent = `<b>🚶 您的位置</b>`;
        if (userHeading !== null && userHeading !== undefined) {
            popupContent += `<br/>方向: ${userHeading.toFixed(0)}°`;
        }
        if (!isWatching) {
            popupContent += `<br/><span class="text-xs text-gray-500">(靜態定位)</span>`;
        }

        // 更新 Marker
        if (!userMarkerRef.current) {
             userMarkerRef.current = L.marker(latLng, { icon: currentIcon, zIndexOffset: 500 })
                .addTo(map)
                .bindPopup(popupContent);
        } else {
             userMarkerRef.current.setLatLng(latLng).setIcon(currentIcon).setPopupContent(popupContent);
        }

        // 2. 更新半徑圈 (僅在追蹤模式下顯示)
        if (isWatching) {
            const radiusInMeters = proximityRadius * 1000;
            if (!userCircleRef.current) {
                userCircleRef.current = L.circle(latLng, {
                    color: '#0044FF', // *** 顏色加深 ***
                    fillColor: '#0044FF',
                    fillOpacity: 0.15, // 稍微增加不透明度
                    radius: radiusInMeters,
                    weight: 2,
                    interactive: false,
                    zIndexOffset: 400 
                }).addTo(map);
            } else {
                userCircleRef.current.setLatLng(latLng).setRadius(radiusInMeters);
            }
        } else {
             // 靜態模式：移除半徑圈
             if (userCircleRef.current) {
                userCircleRef.current.remove();
                userCircleRef.current = null;
            }
        }

    } else {
        if (userMarkerRef.current) {
            userMarkerRef.current.remove();
            userMarkerRef.current = null;
        }
        if (userCircleRef.current) {
            userCircleRef.current.remove();
            userCircleRef.current = null;
        }
    }


    // B. 標記店家 
    stores.slice(0, 50).forEach(store => {
      const isSelected = selectedStore?.id === store.id;

      let distanceHtml = '';
      if (store.distance !== undefined) {
          const isMeters = store.distance < 1;
          const value = isMeters ? (store.distance * 1000).toFixed(0) : store.distance.toFixed(1);
          const unit = isMeters ? '公尺' : 'km';
          distanceHtml = `<span class="text-green-600 font-bold">${value} ${unit}</span><br/>`;
      }

      // *** 顏色調整 ***
      const iconColor = isSelected ? '#FFAA00' : '#FF0000'; // 選中:深金黃, 未選中:正紅
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

      marker.on('click', () => {
          onStoreSelect(store);
      });

      if (isSelected) {
          marker.openPopup();
      }

      markersRef.current.push(marker);
    });
    
  }, [isLeafletLoaded, userLocation, userHeading, isWatching, stores, selectedStore, onStoreSelect, proximityRadius]); 

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
  const [filterCity, setFilterCity] = useState(DEFAULT_CITY);
  const [filterArea, setFilterArea] = useState(DEFAULT_AREA);
  
  // 定位狀態
  const [userLocation, setUserLocation] = useState(null);
  const [userHeading, setUserHeading] = useState(null); // 使用者方向
  const [isWatching, setIsWatching] = useState(false); // 預設：靜態模式 (Static Mode)
  const [proximityRadius, setProximityRadius] = useState(0.1); 
  
  // 強制置中狀態
  const [isRecenterForced, setIsRecenterForced] = useState(false);

  // 列表收合狀態
  const [isListOpen, setIsListOpen] = useState(false); 

  const watchIdRef = useRef(null); 
  const mapControlRef = useRef(null); 

  // 處理列表展開/收合，並強制地圖刷新尺寸
  const handleListToggle = () => {
    const newState = !isListOpen;
    setIsListOpen(newState);
    setTimeout(() => {
        if (mapControlRef.current && mapControlRef.current.forceMapResize) {
            mapControlRef.current.forceMapResize();
        }
    }, 350); 
  };


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
            console.error('Data loading error:', err);
            setError('無法載入店家資料，請檢查 API 來源是否正常。');
            setLoading(false);
        }
    };
    loadData();
  }, []);
  
  // 找出距離最近的店家所屬的縣市和區域 
  const findLocationBasedOnStores = useCallback((location) => {
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

    setFilterCity(''); 
    setFilterArea('');
    setIsWatching(true);
    setError('');
    setIsRecenterForced(false); 

    const successHandler = (position) => {
        const newLocation = {
            lat: position.coords.latitude,
            lng: position.coords.longitude
        };
        setUserLocation(newLocation);
        
        // 更新方向 (heading)
        if (position.coords.heading !== null && !isNaN(position.coords.heading)) {
            setUserHeading(position.coords.heading);
        }
    };

    const errorHandler = (err) => {
        console.error('位置追蹤錯誤:', err);
        setError('無法獲取您的位置，請檢查地理位置權限或網路。');
        
        if (watchIdRef.current) {
             navigator.geolocation.clearWatch(watchIdRef.current);
             watchIdRef.current = null;
        }
        setIsWatching(false); 
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

  // 3. 停止位置追蹤 
  const stopWatchingPosition = useCallback(() => {
      if (watchIdRef.current !== null) {
          navigator.geolocation.clearWatch(watchIdRef.current);
          watchIdRef.current = null;
      }
      setIsWatching(false);

      const { city, area } = findLocationBasedOnStores(userLocation);
      
      setFilterCity(city);
      setFilterArea(area);

      // 保留 userLocation 以便靜態模式顯示
      setSelectedStore(null);
      
      // 修正重點：停止追蹤時，如果還找得到 userLocation，強制置中，不讓地圖跳到區域中心
      if (userLocation) {
          setIsRecenterForced(true);
      } else {
          setIsRecenterForced(false);
      }
      
      setUserHeading(null); 
  }, [findLocationBasedOnStores, userLocation]); 

  // 4. 組件掛載時獲取一次位置 (靜態模式也需要位置)
  useEffect(() => {
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            (position) => {
                const loc = {
                    lat: position.coords.latitude,
                    lng: position.coords.longitude
                };
                setUserLocation(loc);
                
                // 初始一次性獲取方向 (如果可用)
                 if (position.coords.heading !== null && !isNaN(position.coords.heading)) {
                    setUserHeading(position.coords.heading);
                }

                // 初始設定：如果不在追蹤模式，將篩選器切換到使用者目前位置
                if (!isWatching && allStores.length > 0) {
                    const { city, area } = findLocationBasedOnStores(loc);
                    setFilterCity(city);
                    setFilterArea(area);
                    // 初始載入成功後，自動強制置中
                    setIsRecenterForced(true);
                }
            },
            (err) => console.warn("Initial geolocation failed:", err),
            { enableHighAccuracy: true, timeout: 5000 }
        );
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allStores]); 

  // 5. 核心篩選與排序邏輯 
  useEffect(() => {
    let results = [...allStores];

    if (userLocation && isWatching) {
        results = allStores.map(store => ({
            ...store,
            distance: getDistance(userLocation.lat, userLocation.lng, store.lat, store.lng)
        }))
        .filter(store => store.distance <= proximityRadius) 
        .sort((a, b) => a.distance - b.distance); 
        
    } else {
        if (filterCity) results = results.filter(s => s.city === filterCity);
        if (filterArea) results = results.filter(s => s.area === filterArea);
        
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

  // *** 手動置中處理 ***
  const handleRecenter = () => {
      if (userLocation) {
          setIsRecenterForced(true);
          setSelectedStore(null); 
      }
  };

  // 處理篩選器變更 (自動取消強制置中)
  const handleCityChange = (e) => {
    setFilterCity(e.target.value);
    setFilterArea('');
    setIsRecenterForced(false);
  };

  const handleAreaChange = (e) => {
    setFilterArea(e.target.value);
    setIsRecenterForced(false);
  };
  
  // 處理選取店家 (自動取消強制置中)
  const handleStoreSelect = (store) => {
      setSelectedStore(store);
      setIsRecenterForced(false);
  }

  // *** 決定地圖中心點和縮放級別 (已更新置中優先級) ***
  const mapCenter = useMemo(() => {
      // 1. 強制置中 (按鈕 / 初始載入 / 停止追蹤瞬間) - 最高優先級
      if (isRecenterForced && userLocation) {
          return { lat: userLocation.lat, lng: userLocation.lng, zoom: DEFAULT_STATIC_ZOOM };
      }

      // 2. 選中店家
      if (selectedStore) {
          return { lat: selectedStore.lat, lng: selectedStore.lng, zoom: MAX_ZOOM };
      }

      // 3. 追蹤模式
      if (userLocation && isWatching) {
          return { lat: userLocation.lat, lng: userLocation.lng, zoom: MAX_ZOOM };
      }

      // 4. 靜態模式：計算篩選後店家的中心點
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
      
      // 5. 靜態模式：無店家但有位置 -> 置中於使用者 (作為回退)
      if (userLocation) {
          return { 
              lat: userLocation.lat, 
              lng: userLocation.lng, 
              zoom: DEFAULT_STATIC_ZOOM 
          };
      }

      // 6. 最終回退
      return { 
          lat: DEFAULT_STATIC_LAT, 
          lng: DEFAULT_STATIC_LNG, 
          zoom: DEFAULT_STATIC_ZOOM 
      };
  }, [userLocation, isWatching, filteredStores, selectedStore, isRecenterForced]); 

  return (
    // 根容器：使用 h-[100dvh] 解決手機瀏覽器網址列遮擋問題
    <div className="flex flex-col h-[100dvh] bg-gray-50 font-sans overflow-hidden">
        {/* 地圖區：使用 flex-grow 佔滿所有剩餘空間 */}
        <div className="flex-grow relative z-0 shadow-lg min-h-0">
            <LeafletMap 
                centerLat={mapCenter.lat}
                centerLng={mapCenter.lng}
                zoom={mapCenter.zoom}
                userLocation={userLocation}
                userHeading={userHeading} // 傳遞方向資訊給地圖元件
                isWatching={isWatching}    // 傳遞是否在追蹤模式
                stores={filteredStores}
                selectedStore={selectedStore}
                onStoreSelect={handleStoreSelect} // 使用新的 handleStoreSelect
                proximityRadius={proximityRadius} 
                mapControlRef={mapControlRef} 
            />
            
            {/* 浮動控制面板 (定位按鈕) - 位於右下角，位置稍微調高確保不被列表遮擋 */}
            <div className="absolute bottom-8 right-4 z-[1000] flex flex-col gap-2">
                {/* 置中按鈕 (僅在有使用者位置時顯示) */}
                {userLocation && (
                    <button 
                        onClick={handleRecenter} 
                        className={`p-3 rounded-full shadow-xl transition-all flex justify-center items-center ${isRecenterForced ? 'bg-blue-100 text-blue-700 border-2 border-blue-500' : 'bg-white text-blue-600 hover:bg-gray-100'}`}
                        title="置中到我的位置"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064" />
                        </svg>
                    </button>
                )}

                <button 
                    onClick={isWatching ? stopWatchingPosition : startWatchingPosition}
                    className={`p-3 rounded-full shadow-xl transition-all flex items-center justify-center ${
                        isWatching 
                            ? 'bg-red-500 hover:bg-red-600 text-white' 
                            : 'bg-white hover:bg-gray-100 text-blue-600 border-2 border-blue-600'
                    } text-lg`}
                    title={isWatching ? "點擊停止實時追蹤" : "點擊開始實時追蹤"}
                >
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
            {userLocation && (
                <div className="absolute top-4 left-4 z-[1000] bg-white text-gray-700 px-3 py-1 rounded shadow-lg text-xs font-medium border border-gray-200">
                    {isWatching ? <><span className="text-red-500">• 實時追蹤</span> | 方向: {userHeading !== null ? `${userHeading.toFixed(0)}°` : '未知'}</> : <span className="text-blue-500">• 靜態模式</span>}
                </div>
            )}
        </div>

        {/* 列表區 - 根據 isListOpen 動態調整高度 */}
        <div 
            className={`bg-white shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.1)] z-10 flex flex-col transition-all duration-300 ease-in-out flex-shrink-0
                ${isListOpen ? 'h-[40vh]' : 'h-14'}
            `}
        >
            {/* 1. Header (可點擊收合/展開) */}
            <div 
                className="flex-shrink-0 p-3 border-b bg-gray-50 flex justify-between items-center cursor-pointer select-none" 
                onClick={handleListToggle}
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
                            onChange={handleCityChange}
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
                                onChange={handleAreaChange}
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
                                <option value="20">20 km 內</option>
                            </select>
                        )}
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
                            店家資料與初始定位載入中...
                        </div>
                    ) : filteredStores.length === 0 ? (
                        <div className="text-center py-10 text-gray-500 p-4 border border-dashed border-gray-300 rounded-lg">
                            <svg xmlns="http://www.w3.org/2000/svg" className="mx-auto h-8 w-8 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                            </svg>
                            <p className="mt-2 text-sm font-medium">
                                {isWatching && userLocation ? `在 ${proximityRadius * 1000} 公尺內沒有找到店家。` : '未找到符合條件的店家。'}
                            </p>
                        </div>
                    ) : (
                        filteredStores.map(store => (
                            <div 
                                key={store.id}
                                onClick={() => handleStoreSelect(store)}
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

const rootElement = document.getElementById('root');
if (rootElement) { const root = createRoot(rootElement); root.render(<App />); }