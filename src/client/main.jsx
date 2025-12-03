import React, { useState, useEffect, useMemo } from 'react';
// 修正：從 react-dom/client 具名匯入 createRoot，解決 TypeError 錯誤。
import { createRoot } from 'react-dom/client'; 

// API 位址，用於從外部服務獲取數據
// 開發環境使用本地 API（通過 Vite 代理），生產環境使用 Render
const API_URL = import.meta.env.DEV 
  ? '/api/stores' 
  : 'https://patrol-master.onrender.com/api/stores';
// 台灣中心點的經緯度 (用於初始地圖顯示)
const TAIWAN_CENTER_LAT = 23.6978;
const TAIWAN_CENTER_LNG = 120.9605;

/**
 * Haversine 公式：計算地球上兩點之間的直線距離 (單位: km)
 * @param {number} lat1 點1 緯度
 * @param {number} lon1 點1 經度
 * @param {number} lat2 點2 緯度
 * @param {number} lon2 點2 經度
 * @returns {number} 兩點間的距離 (km)
 */
const getDistance = (lat1, lon1, lat2, lon2) => {
  const R = 6371; // 地球半徑 (km)
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a = 
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c; // 距離 (km)
};

// 輔助函數：將巢狀數據結構扁平化為單一的店家列表
const flattenStoreData = (nestedData) => {
  let stores = [];
  if (!nestedData) return [];
  
  // 遍歷所有縣市
  for (const cityKey in nestedData) {
    if (nestedData.hasOwnProperty(cityKey)) {
      const cityData = nestedData[cityKey];
      
      // 遍歷縣市下的所有區域
      for (const areaKey in cityData) {
        if (cityData.hasOwnProperty(areaKey) && cityData[areaKey] && Array.isArray(cityData[areaKey].data)) {
          // 將區域內的店家數據加入總列表
          stores = stores.concat(cityData[areaKey].data);
        }
      }
    }
  }
  
  // 篩選出具有有效經緯度且名稱不為空值的店家
  return stores.filter(store => 
    store.lat && store.lng && typeof store.lat === 'number' && typeof store.lng === 'number' && store.name
  ).map((store, index) => ({
      ...store,
      // 為每個店家創建一個唯一的 ID，如果原始數據沒有提供
      id: store.id || `${store.city}-${store.area}-${index}`
  }));
};

// 地圖組件：使用 Google Maps iframe 嵌入顯示選定的位置
const StoreMap = ({ lat, lng, name, isLoading }) => {
  const mapUrl = useMemo(() => {
    // 構造 Google Maps 嵌入 URL
    const marker = `${lat},${lng}`;
    const center = `${lat},${lng}`;
    const zoom = 15;
    
    return `https://maps.google.com/maps?q=${marker}&z=${zoom}&t=k&output=embed`;
  }, [lat, lng]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center bg-gray-200 rounded-lg h-96 w-full text-gray-600">
        正在載入地圖...
      </div>
    );
  }

  return (
    <div className="mt-6 border-4 border-blue-200 rounded-xl overflow-hidden shadow-lg">
      <h3 className="text-xl font-semibold p-3 bg-blue-50 text-blue-800">
        地圖定位：{name || '請選擇一個店家'}
      </h3>
      {lat && lng ? (
        <iframe
          width="100%"
          height="400"
          loading="lazy"
          allowFullScreen
          referrerPolicy="no-referrer-when-downgrade"
          src={mapUrl}
          title={`地圖顯示: ${name}`}
        ></iframe>
      ) : (
        <div className="flex items-center justify-center bg-gray-100 h-96 w-full text-gray-500">
          地圖尚未選擇定位，請從列表中選擇一家店鋪。
        </div>
      )}
    </div>
  );
};


const App = () => {
  const [allStores, setAllStores] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedStore, setSelectedStore] = useState(null);
  
  // 篩選狀態
  const [filterCity, setFilterCity] = useState('');
  const [filterArea, setFilterArea] = useState('');
  
  // 定位狀態
  const [userLocation, setUserLocation] = useState(null);
  const [isLocating, setIsLocating] = useState(false);
  // 半徑篩選 (km)
  const [proximityRadius, setProximityRadius] = useState(10); 
  const radiusOptions = [5, 10, 20, 50, 100];


  // 獲取所有唯一的城市名稱，用於篩選下拉選單
  const uniqueCities = useMemo(() => {
    const cities = new Set(allStores.map(store => store.city).filter(Boolean));
    return ['', ...Array.from(cities).sort()];
  }, [allStores]);

  // 獲取當前城市下的所有唯一區域名稱
  const uniqueAreas = useMemo(() => {
      if (!filterCity) return [''];
      
      const areas = new Set(
          allStores
              .filter(store => store.city === filterCity)
              .map(store => store.area)
              .filter(Boolean)
      );
      return ['', ...Array.from(areas).sort()];
  }, [allStores, filterCity]);


  // 根據篩選器/定位過濾並排序店家列表 (使用 useMemo 確保性能和穩定性)
  const filteredStores = useMemo(() => {
    // 總是從一個乾淨的副本開始
    let stores = [...allStores];
    
    // 判斷是否為「定位模式」 (有定位資訊且未啟動城市篩選)
    const isProximityMode = userLocation && !filterCity;

    if (isProximityMode) {
        const { lat: userLat, lng: userLng } = userLocation;

        // 1. 計算所有店家的距離並加入 distance 屬性
        stores = stores.map(store => {
            // 由於 store.lat/lng 在 flattenStoreData 中已驗證為 number，這裡可以直接使用
            const distance = getDistance(userLat, userLng, store.lat, store.lng);
            return {
                ...store,
                distance: distance
            };
        });
        
        // 2. 篩選出在半徑內的店家
        stores = stores.filter(store => store.distance <= proximityRadius);
        
        // 3. 依照距離排序 (最近的在前)
        stores.sort((a, b) => a.distance - b.distance);
        
    } else {
        // 非定位模式 (城市/區域篩選模式或無篩選)
        
        // 1. 應用城市篩選
        if (filterCity) {
            stores = stores.filter(store => store.city === filterCity);
        }
        
        // 2. 應用區域篩選
        if (filterArea) {
            stores = stores.filter(store => store.area === filterArea);
        }
        
        // 3. 移除 distance 屬性，確保在非定位模式下店鋪對象是乾淨的
        stores = stores.map(store => {
            const { distance, ...rest } = store;
            return rest;
        });
    }

    return stores;
  }, [allStores, filterCity, filterArea, userLocation, proximityRadius]);


  // 數據載入邏輯
  useEffect(() => {
    const loadStoreData = async () => {
      let retries = 0;
      const maxRetries = 5;
      let success = false;
      
      while (retries < maxRetries && !success) {
          try {
            setLoading(true);
            
            const response = await fetch(API_URL);

            if (!response.ok) {
              throw new Error(`無法載入 API 數據，狀態碼: ${response.status}`);
            }

            const rawData = await response.json();
            const flattenedData = flattenStoreData(rawData);
            
            setAllStores(flattenedData);
            setError('');
            success = true;

            // 預設選擇第一個店家作為地圖中心點 (如果沒有自動定位的話)
            setSelectedStore(prevStore => {
                 if (flattenedData.length > 0 && !prevStore) {
                     // 只有在還沒有任何定位資訊時才設定預設值
                     if (!userLocation) { 
                         return flattenedData[0];
                     }
                 }
                 return prevStore;
            });
            
          } catch (err) {
            console.error(`載入和處理數據時發生錯誤 (嘗試 ${retries + 1}/${maxRetries}):`, err);
            if (retries < maxRetries - 1) {
                const delay = Math.pow(2, retries) * 1000;
                // 實施指數退避 (Exponential Backoff)
                await new Promise(resolve => setTimeout(resolve, delay)); 
            } else {
                setError(`數據處理失敗: ${err.message}. 請檢查 API (${API_URL}) 是否可用或格式是否正確。`);
            }
            retries++;
          } finally {
             if (success || retries === maxRetries) {
                 setLoading(false);
             }
          }
      }
    };

    loadStoreData();
  }, [userLocation]); // 加上 userLocation 作為依賴，以便在定位成功後檢查是否需要設定預設店家


  // 處理縣市變更，並重設區域篩選
  const handleCityChange = (e) => {
    const newCity = e.target.value;
    setFilterCity(newCity);
    setFilterArea(''); // 縣市變更時，重設區域篩選
    setUserLocation(null); // 清除定位，改為使用篩選
  };

  // 處理區域變更
  const handleAreaChange = (e) => {
    setFilterArea(e.target.value);
    setUserLocation(null); // 清除定位，改為使用篩選
  };
  
  // 處理店鋪點擊事件
  const handleStoreClick = (store) => {
    setSelectedStore(store);
    const mapElement = document.getElementById('store-map-view');
    if (mapElement) {
      mapElement.scrollIntoView({ behavior: 'smooth' });
    }
  };

  // 處理定位功能
  const handleLocateMe = () => {
    if (!navigator.geolocation) {
        setError('您的瀏覽器不支持地理位置功能。');
        return;
    }

    setIsLocating(true);
    setError('');

    navigator.geolocation.getCurrentPosition(
        (position) => {
            const newLocation = {
                lat: position.coords.latitude,
                lng: position.coords.longitude
            };
            setUserLocation(newLocation);
            setIsLocating(false);
            
            // 啟用定位時，清除城市/區域篩選
            setFilterCity('');
            setFilterArea('');
            
            // 設定地圖中心為用戶位置
            setSelectedStore({
                id: 'user-location',
                name: '您的當前位置',
                lat: newLocation.lat,
                lng: newLocation.longitude,
                city: '定位',
                area: '成功'
            });

        },
        (err) => {
            console.error(err);
            // 統一錯誤提示
            let message = '無法獲取您的位置。';
            if (err.code === err.PERMISSION_DENIED) {
                 message += ' 請檢查瀏覽器是否允許存取地理位置。';
            } else if (err.code === err.POSITION_UNAVAILABLE) {
                 message += ' 位置資訊無法取得。';
            } else if (err.code === err.TIMEOUT) {
                 message += ' 請求超時。';
            }
            // 只有在沒有其他錯誤時才設定定位錯誤
            setError(prevError => prevError.includes('API 數據') ? prevError : message);
            setIsLocating(false);
        },
        { enableHighAccuracy: true, timeout: 5000, maximumAge: 0 }
    );
  };
  
  // ============================== 新增：自動定位功能 ==============================
  useEffect(() => {
    // 檢查瀏覽器是否支持地理位置功能
    if (navigator.geolocation) {
        // 在組件第一次渲染後自動觸發定位
        handleLocateMe(); 
    } else {
        // 如果瀏覽器不支持，顯示錯誤，但不覆蓋 API 載入錯誤
        console.error('瀏覽器不支持地理位置功能。');
        setError(prevError => prevError || '您的瀏覽器不支持地理位置功能，無法自動定位。');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // 僅在組件掛載時運行一次
  // ==============================================================================


  // 確定地圖中心點的經緯度
  const mapCenterLat = selectedStore?.lat || userLocation?.lat || TAIWAN_CENTER_LAT;
  const mapCenterLng = selectedStore?.lng || userLocation?.lng || TAIWAN_CENTER_LNG;
  const mapCenterName = selectedStore?.name;


  if (error && !isLocating) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="max-w-xl w-full bg-white shadow-xl rounded-xl p-8 border-l-8 border-red-500">
          <h1 className="text-2xl font-bold text-red-600 mb-4">載入或定位錯誤</h1>
          <p className="text-gray-700">{error}</p>
          <p className="mt-4 text-sm text-gray-500">
            請確保 API 位址：<code>{API_URL}</code> 可正常連線，或檢查地理位置權限。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col lg:flex-row p-4 md:p-8 font-sans">
      {/* 樣式已移至 index.html 的 <head> 中，這裡只保留結構和 Tailwind 類別 */}

      {/* 左側：地圖和控制台 */}
      <div className="w-full lg:w-3/5 lg:pr-4 mb-6 lg:mb-0">
        <div className="bg-white shadow-xl rounded-xl p-6" id="store-map-view">
          <h1 className="text-3xl font-extrabold text-gray-900 mb-4 border-b pb-2">
            台灣娃娃機店家地圖
          </h1>
          <p className="text-sm text-gray-500 mb-4">
            總計找到 <span className="font-bold text-blue-600">{allStores.length}</span> 個具有完整座標的店家資訊。
          </p>
          
          <StoreMap 
            lat={mapCenterLat}
            lng={mapCenterLng}
            name={mapCenterName}
            isLoading={loading || isLocating}
          />
        </div>
      </div>

      {/* 右側：店家列表和篩選 */}
      <div className="w-full lg:w-2/5">
        <div className="bg-white shadow-xl rounded-xl p-6">
          <h2 className="text-2xl font-bold text-gray-800 mb-4">店家列表與篩選</h2>
          
          {/* 定位按鈕 */}
          <button
              onClick={handleLocateMe}
              disabled={isLocating || loading}
              className={`w-full py-3 px-4 mb-4 rounded-lg font-bold transition-colors ${
                  isLocating || loading
                      ? 'bg-gray-400 text-gray-600 cursor-not-allowed'
                      : 'bg-green-600 hover:bg-green-700 text-white shadow-md'
              }`}
          >
              {isLocating ? (
                  <span className="flex items-center justify-center">
                      <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                      正在偵測您的位置...
                  </span>
              ) : userLocation ? '重新偵測我的位置' : '偵測我的當前位置 (自動排序最近店家)'}
          </button>
          
          {/* 篩選器容器 */}
          <div className="mb-4 space-y-4 border-t pt-4">
              
              {/* 定位資訊與半徑篩選 */}
              {userLocation && !filterCity ? (
                  <div className="bg-green-50 p-3 rounded-lg border border-green-200">
                      <p className="text-sm font-semibold text-green-800 mb-2">
                          🎯 已定位！
                          <span className="text-xs text-green-600 ml-2">(Lat: {userLocation.lat.toFixed(4)}, Lng: {userLocation.lng.toFixed(4)})</span>
                      </p>
                      
                      {/* 半徑篩選器 */}
                      <div>
                          <label htmlFor="radius-filter" className="block text-sm font-medium text-gray-700 mb-1">
                              顯示半徑內的店家 (km):
                          </label>
                          <select
                              id="radius-filter"
                              value={proximityRadius}
                              onChange={(e) => setProximityRadius(Number(e.target.value))}
                              className="mt-1 block w-full pl-3 pr-10 py-2 text-base border-gray-300 focus:outline-none focus:ring-green-500 focus:border-green-500 sm:text-sm rounded-md shadow-sm"
                          >
                              {radiusOptions.map(radius => (
                                  <option key={radius} value={radius}>
                                      {radius} km
                                  </option>
                              ))}
                          </select>
                      </div>
                  </div>
              ) : (
                  // 縣市篩選器
                  <div className="grid grid-cols-2 gap-4">
                      {/* 縣市篩選器 */}
                      <div>
                          <label htmlFor="city-filter" className="block text-sm font-medium text-gray-700 mb-1">
                              縣市篩選:
                          </label>
                          <select
                              id="city-filter"
                              value={filterCity}
                              onChange={handleCityChange}
                              className="mt-1 block w-full pl-3 pr-10 py-2 text-base border-gray-300 focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm rounded-md shadow-sm"
                          >
                              {uniqueCities.map(city => (
                                  <option key={city} value={city}>
                                      {city || '所有縣市'}
                                  </option>
                              ))}
                          </select>
                      </div>

                      {/* 區域篩選器 (鄉/鎮/區) - 只有選擇縣市後才顯示 */}
                      {filterCity && (
                          <div>
                              <label htmlFor="area-filter" className="block text-sm font-medium text-gray-700 mb-1">
                                  區域篩選:
                              </label>
                              <select
                                  id="area-filter"
                                  value={filterArea}
                                  onChange={handleAreaChange}
                                  className="mt-1 block w-full pl-3 pr-10 py-2 text-base border-gray-300 focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm rounded-md shadow-sm"
                              >
                                  {uniqueAreas.map(area => (
                                      <option key={area} value={area}>
                                          {area || '所有區域'}
                                      </option>
                                  ))}
                              </select>
                          </div>
                      )}
                  </div>
              )}
          </div>
          
          <p className="text-xs text-gray-500 mt-2">
            目前顯示 <span className="font-bold">{filteredStores.length}</span> 個店家。
            {userLocation && !filterCity && <span className="ml-1">（已按距離排序）</span>}
          </p>

          {loading ? (
            <div className="flex justify-center items-center py-12 text-blue-600">
              <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-blue-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              數據載入中...
            </div>
          ) : (
            <div className="store-list-container space-y-3 mt-4">
              {filteredStores.length > 0 ? (
                filteredStores.map((store) => (
                  <div
                    key={store.id}
                    className={`store-item p-3 rounded-lg border border-gray-200 ${
                      selectedStore?.id === store.id ? 'selected' : 'bg-white'
                    }`}
                    onClick={() => handleStoreClick(store)}
                    title={`點擊在地圖上查看 ${store.name}`}
                  >
                    <p className="font-semibold text-gray-900 truncate">
                      {store.name}
                    </p>
                    <p className="text-sm text-gray-500">
                      {store.city} {store.area}
                      {/* 顯示距離，如果它存在 (代表已定位) */}
                      {store.distance !== undefined && (
                        <span className="ml-2 font-bold text-green-600">
                          ({store.distance.toFixed(2)} km)
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-gray-400 truncate">
                      地址: {store.address}
                    </p>
                  </div>
                ))
              ) : (
                <div className="text-center py-10 text-gray-500">
                  <p>未找到符合條件的店家，請調整篩選條件。</p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// 將整個應用程式掛載到 DOM
// 修正：使用具名匯入的 createRoot
createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);