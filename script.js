// Exchange API Configuration
const EXCHANGES = {
    variational: {
        name: 'Variational',
        baseUrl: 'https://omni-client-api.prod.ap-northeast-1.variational.io',
        statsEndpoint: '/metadata/stats'
    },
    lighter: {
        name: 'Lighter',
        baseUrl: 'https://mainnet.zklighter.elliot.ai',
        wsUrl: 'wss://mainnet.zklighter.elliot.ai/stream',
        endpoint: '/api/v1/orderBooks',
        authToken: 'ro:92374:single:1854227934:d2a84b224e888823ecb03dc3e90b3cefd0802253ceb8cc9456c6aec01d551cb2'
    }
};

// Global state
let allPairs = [];
let commonPairs = [];
let currentSort = { column: 'score', direction: 'desc' };
let weights = {
    volume: 40,
    oi: 35,
    funding: 25
};

// Fetch Variational data
async function fetchVariationalData() {
    try {
        const response = await fetch(`${EXCHANGES.variational.baseUrl}${EXCHANGES.variational.statsEndpoint}`);
        if (!response.ok) {
            throw new Error(`Variational API error: ${response.status}`);
        }
        const data = await response.json();
        
        // Debug: Log first listing to see API structure
        if (data.listings && data.listings.length > 0) {
            console.log('=== Variational API Response Sample ===');
            console.log(JSON.stringify(data.listings[0], null, 2));
            console.log('Available fields:', Object.keys(data.listings[0]));
        }
        
        const pairs = {};
        if (data.listings && Array.isArray(data.listings)) {
            data.listings.forEach((listing, index) => {
                const ticker = listing.ticker;
                if (!ticker) return;
                
                // Parse funding rate (annual rate)
                const fundingRateRaw = listing.funding_rate;
                const fundingRateDecimal = typeof fundingRateRaw === 'string' 
                    ? parseFloat(fundingRateRaw || '0') 
                    : (fundingRateRaw || 0);
                const annualRatePercent = fundingRateDecimal * 100;
                
                // Funding interval
                const fundingIntervalSeconds = listing.funding_interval_s || 28800;
                const fundingIntervalHours = fundingIntervalSeconds / 3600;
                
                // Calculate interval rate from annual
                const intervalsPerYear = (365 * 24) / fundingIntervalHours;
                const intervalRatePercent = annualRatePercent / intervalsPerYear;
                
                // Parse volume (24h)
                const volume24h = parseFloat(listing.volume_24h || listing.volume || 0);
                
                // Parse Open Interest - open_interest is an object with long_open_interest and short_open_interest
                let longOI = 0;
                let shortOI = 0;
                
                if (listing.open_interest && typeof listing.open_interest === 'object') {
                    longOI = parseFloat(listing.open_interest.long_open_interest || 0);
                    shortOI = parseFloat(listing.open_interest.short_open_interest || 0);
                }
                
                const totalOI = longOI + shortOI;
                
                // Calculate Long/Short ratio from OI values
                let longRatio = 0.5;
                let shortRatio = 0.5;
                
                if (totalOI > 0) {
                    longRatio = longOI / totalOI;
                    shortRatio = shortOI / totalOI;
                }
                
                // Calculate OI difference (how far from 50/50)
                const oiDifference = Math.abs(longRatio - shortRatio);
                
                // Parse spread from quotes.size_1k
                let spread = 0;
                let spreadBps = 0;
                let bid1k = 0;
                let ask1k = 0;
                
                if (listing.quotes && listing.quotes.size_1k) {
                    bid1k = parseFloat(listing.quotes.size_1k.bid || 0);
                    ask1k = parseFloat(listing.quotes.size_1k.ask || 0);
                    
                    if (bid1k > 0 && ask1k > 0) {
                        spread = ask1k - bid1k;
                        const midPrice = (bid1k + ask1k) / 2;
                        spreadBps = (spread / midPrice) * 10000; // basis points
                    }
                }
                
                // Debug first few pairs
                if (index < 3) {
                    console.log(`[${ticker}] longOI: ${longOI}, shortOI: ${shortOI}, spread: ${spreadBps.toFixed(2)} bps`);
                }
                
                pairs[ticker] = {
                    ticker: ticker,
                    name: listing.name || ticker,
                    volume24h: volume24h,
                    openInterest: totalOI || (longOI + shortOI),
                    longOI: longOI,
                    shortOI: shortOI,
                    longRatio: longRatio,
                    shortRatio: shortRatio,
                    oiDifference: oiDifference,
                    fundingRateInterval: intervalRatePercent,
                    fundingRateAPR: annualRatePercent,
                    fundingIntervalHours: fundingIntervalHours,
                    bid1k: bid1k,
                    ask1k: ask1k,
                    spread: spread,
                    spreadBps: spreadBps
                };
            });
        }
        
        console.log(`Variational API: Fetched ${Object.keys(pairs).length} pairs`);
        return pairs;
    } catch (error) {
        console.error('Error fetching Variational data:', error);
        return {};
    }
}

// Fetch Lighter pairs list
async function fetchLighterPairs() {
    const pairs = new Set();
    
    // Try REST endpoint first
    try {
        const response = await fetch(`${EXCHANGES.lighter.baseUrl}${EXCHANGES.lighter.endpoint}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': EXCHANGES.lighter.authToken
            }
        });
        
        if (response.ok) {
            const data = await response.json();
            
            if (data.order_books && Array.isArray(data.order_books)) {
                data.order_books.forEach(item => {
                    if (item.symbol) {
                        let symbol = item.symbol;
                        if (symbol.includes('-')) {
                            symbol = symbol.split('-')[0];
                        }
                        if (symbol.endsWith('USDC')) {
                            symbol = symbol.replace('USDC', '');
                        }
                        if (symbol.endsWith('USDT')) {
                            symbol = symbol.replace('USDT', '');
                        }
                        pairs.add(symbol.toUpperCase());
                    }
                });
            }
        }
    } catch (error) {
        console.warn('Lighter REST API failed:', error.message);
    }
    
    // If REST failed, try WebSocket
    if (pairs.size === 0) {
        console.log('Trying Lighter WebSocket...');
        const wsPairs = await fetchLighterPairsWebSocket();
        wsPairs.forEach(p => pairs.add(p));
    }
    
    console.log(`Lighter: Found ${pairs.size} pairs`);
    return pairs;
}

// Fetch Lighter pairs via WebSocket
function fetchLighterPairsWebSocket() {
    return new Promise((resolve) => {
        const pairs = new Set();
        let ws = null;
        let timeoutId = null;
        let resolved = false;
        
        const resolveOnce = () => {
            if (resolved) return;
            resolved = true;
            if (timeoutId) clearTimeout(timeoutId);
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.close();
            }
            resolve(pairs);
        };
        
        try {
            ws = new WebSocket(EXCHANGES.lighter.wsUrl);
            
            timeoutId = setTimeout(() => {
                console.log('Lighter WebSocket timeout');
                resolveOnce();
            }, 10000);
            
            ws.onopen = () => {
                console.log('Lighter WebSocket connected');
                ws.send(JSON.stringify({ type: 'subscribe', channel: 'market_stats/all' }));
            };
            
            ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    
                    if (data.market_stats) {
                        const stats = data.market_stats;
                        
                        if (typeof stats === 'object') {
                            Object.keys(stats).forEach(key => {
                                const marketStats = stats[key];
                                let symbol = marketStats.symbol || `MARKET_${key}`;
                                
                                if (symbol.includes('-')) {
                                    symbol = symbol.split('-')[0];
                                }
                                if (symbol.endsWith('USDC') || symbol.endsWith('USDT')) {
                                    symbol = symbol.replace(/USD[CT]$/, '');
                                }
                                
                                pairs.add(symbol.toUpperCase());
                            });
                            
                            if (pairs.size > 0) {
                                resolveOnce();
                            }
                        }
                    }
                } catch (e) {
                    // Ignore parse errors
                }
            };
            
            ws.onerror = () => resolveOnce();
            ws.onclose = () => resolveOnce();
            
        } catch (error) {
            resolve(pairs);
        }
    });
}

// Calculate priority score based on weights
function calculateScore(pair, maxVolume, maxOI, maxFunding) {
    // Normalize values to 0-1 range
    // Volume: LOWER is better (inverted score)
    const volumeScore = maxVolume > 0 ? (1 - (pair.volume24h / maxVolume)) : 1;
    
    const oiScore = maxOI > 0 ? (pair.openInterest / maxOI) : 0;
    
    // For funding, use absolute value (higher absolute = more interesting)
    const fundingScore = maxFunding > 0 ? (Math.abs(pair.fundingRateAPR) / maxFunding) : 0;
    
    // OI imbalance factor
    const oiImbalanceScore = pair.oiDifference;
    
    // Combined score with weights
    const totalWeight = weights.volume + weights.oi + weights.funding;
    const normalizedWeights = {
        volume: weights.volume / totalWeight,
        oi: weights.oi / totalWeight,
        funding: weights.funding / totalWeight
    };
    
    // OI score includes both absolute OI and imbalance
    const combinedOiScore = (oiScore * 0.6 + oiImbalanceScore * 0.4);
    
    const score = (
        volumeScore * normalizedWeights.volume +
        combinedOiScore * normalizedWeights.oi +
        fundingScore * normalizedWeights.funding
    ) * 100;
    
    return score;
}

// Format number with abbreviation
function formatNumber(num) {
    if (num === null || num === undefined || isNaN(num)) return '-';
    
    if (num >= 1e9) {
        return `$${(num / 1e9).toFixed(2)}B`;
    } else if (num >= 1e6) {
        return `$${(num / 1e6).toFixed(2)}M`;
    } else if (num >= 1e3) {
        return `$${(num / 1e3).toFixed(2)}K`;
    }
    return `$${num.toFixed(2)}`;
}

// Format funding rate
function formatFundingRate(rate, interval) {
    if (rate === null || rate === undefined || isNaN(rate)) return { rate: '-', apr: '-' };
    const sign = rate >= 0 ? '+' : '';
    return {
        rate: `${sign}${rate.toFixed(4)}%`,
        interval: `${interval}h`
    };
}

// Sort pairs
function sortPairs(pairs, column, direction) {
    return [...pairs].sort((a, b) => {
        let aVal, bVal;
        
        switch (column) {
            case 'rank':
                aVal = a.rank || 999;
                bVal = b.rank || 999;
                break;
            case 'ticker':
                aVal = (a.ticker || '').toLowerCase();
                bVal = (b.ticker || '').toLowerCase();
                return direction === 'asc' 
                    ? aVal.localeCompare(bVal)
                    : bVal.localeCompare(aVal);
            case 'volume':
                aVal = a.volume24h || 0;
                bVal = b.volume24h || 0;
                break;
            case 'oi':
                aVal = a.openInterest || 0;
                bVal = b.openInterest || 0;
                break;
            case 'oiRatio':
                aVal = a.oiDifference || 0;
                bVal = b.oiDifference || 0;
                break;
            case 'funding':
                aVal = Math.abs(a.fundingRateAPR || 0);
                bVal = Math.abs(b.fundingRateAPR || 0);
                break;
            case 'spread':
                aVal = a.spreadBps || 0;
                bVal = b.spreadBps || 0;
                break;
            case 'score':
                aVal = a.score || 0;
                bVal = b.score || 0;
                break;
            default:
                return 0;
        }
        
        return direction === 'asc' ? aVal - bVal : bVal - aVal;
    });
}

// Display Top 3 Cards
function displayTopCards(pairs) {
    const top3 = pairs.slice(0, 3);
    
    for (let i = 0; i < 3; i++) {
        const card = document.getElementById(`topCard${i + 1}`);
        if (!card) continue;
        
        const pair = top3[i];
        
        if (pair) {
            card.querySelector('.card-ticker').textContent = pair.ticker;
            card.querySelector('.card-score').textContent = `${pair.score.toFixed(1)} pts`;
            
            const funding = formatFundingRate(pair.fundingRateInterval, pair.fundingIntervalHours);
            const longPercent = (pair.longRatio * 100).toFixed(1);
            const details = card.querySelector('.card-details');
            details.innerHTML = `
                <span class="detail-item">Vol: ${formatNumber(pair.volume24h)}</span>
                <span class="detail-item">L/S: ${longPercent}%</span>
                <span class="detail-item">Fund: ${funding.rate}</span>
            `;
        } else {
            card.querySelector('.card-ticker').textContent = '-';
            card.querySelector('.card-score').textContent = '-';
            card.querySelector('.card-details').innerHTML = `
                <span class="detail-item">Vol: -</span>
                <span class="detail-item">L/S: -</span>
                <span class="detail-item">Fund: -</span>
            `;
        }
    }
}

// Display table
function displayTable(pairs) {
    const tableBody = document.getElementById('tableBody');
    
    if (pairs.length === 0) {
        tableBody.innerHTML = `
            <tr>
                <td colspan="8" style="text-align: center; padding: 40px; color: #6B7280;">
                    공통 페어가 없습니다
                </td>
            </tr>
        `;
        return;
    }
    
    // Sort pairs
    let sortedPairs = sortPairs(pairs, currentSort.column, currentSort.direction);
    
    // Update ranks
    if (currentSort.column === 'score' && currentSort.direction === 'desc') {
        sortedPairs.forEach((pair, index) => {
            pair.rank = index + 1;
        });
    }
    
    // Find max score for bar visualization
    const maxScore = Math.max(...sortedPairs.map(p => p.score || 0));
    
    tableBody.innerHTML = sortedPairs.map(pair => {
        const rankClass = pair.rank <= 3 ? `rank-${pair.rank}` : '';
        const longPercent = (pair.longRatio * 100) || 50;
        const funding = formatFundingRate(pair.fundingRateInterval, pair.fundingIntervalHours);
        const fundingClass = pair.fundingRateInterval >= 0 ? 'positive' : 'negative';
        const scorePercent = maxScore > 0 ? ((pair.score / maxScore) * 100) : 0;
        const aprSign = pair.fundingRateAPR >= 0 ? '+' : '';
        
        // Format spread
        const spreadDisplay = pair.spreadBps > 0 
            ? `${pair.spreadBps.toFixed(2)} bps`
            : '-';
        const spreadClass = pair.spreadBps > 50 ? 'spread-high' : pair.spreadBps > 20 ? 'spread-medium' : 'spread-low';
        
        return `
            <tr>
                <td class="rank-cell ${rankClass}">#${pair.rank || '-'}</td>
                <td class="ticker-cell">${pair.ticker}</td>
                <td class="volume-cell">${formatNumber(pair.volume24h)}</td>
                <td class="oi-cell">
                    <div class="oi-values">
                        <span class="oi-long">${formatNumber(pair.longOI)}</span>
                        <span class="oi-separator">/</span>
                        <span class="oi-short">${formatNumber(pair.shortOI)}</span>
                    </div>
                </td>
                <td>
                    <div class="ratio-cell">
                        <div class="ratio-bar">
                            <div class="ratio-bar-fill" style="width: ${longPercent}%"></div>
                        </div>
                        <span class="ratio-text">${longPercent.toFixed(1)}% / ${(100 - longPercent).toFixed(1)}%</span>
                    </div>
                </td>
                <td class="spread-cell ${spreadClass}">${spreadDisplay}</td>
                <td>
                    <div class="funding-cell">
                        <span class="funding-rate ${fundingClass}">${funding.rate} - ${funding.interval}</span>
                        <span class="funding-apr">(APR: ${aprSign}${pair.fundingRateAPR.toFixed(2)}%)</span>
                    </div>
                </td>
                <td>
                    <div class="score-cell">
                        <span class="score-value">${pair.score.toFixed(1)}</span>
                        <div class="score-bar">
                            <div class="score-bar-fill" style="width: ${scorePercent}%"></div>
                        </div>
                    </div>
                </td>
            </tr>
        `;
    }).join('');
    
    updateSortIcons();
}

// Update sort icons
function updateSortIcons() {
    const headers = document.querySelectorAll('th.sortable');
    headers.forEach(header => {
        header.classList.remove('sort-asc', 'sort-desc');
        const sortColumn = header.getAttribute('data-sort');
        if (currentSort.column === sortColumn) {
            header.classList.add(currentSort.direction === 'asc' ? 'sort-asc' : 'sort-desc');
        }
    });
}

// Setup sorting
function setupSorting() {
    const headers = document.querySelectorAll('th.sortable');
    headers.forEach(header => {
        header.addEventListener('click', () => {
            const column = header.getAttribute('data-sort');
            
            if (currentSort.column === column) {
                currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
            } else {
                currentSort.column = column;
                currentSort.direction = column === 'ticker' ? 'asc' : 'desc';
            }
            
            applyFiltersAndDisplay();
        });
    });
}

// Setup search
function setupSearch() {
    const searchInput = document.getElementById('searchInput');
    searchInput.addEventListener('input', () => {
        applyFiltersAndDisplay();
    });
}

// Setup weight controls - weights always sum to 100
function setupWeightControls() {
    const volumeSlider = document.getElementById('volumeWeight');
    const oiSlider = document.getElementById('oiWeight');
    const fundingSlider = document.getElementById('fundingWeight');
    
    const volumeValue = document.getElementById('volumeWeightValue');
    const oiValue = document.getElementById('oiWeightValue');
    const fundingValue = document.getElementById('fundingWeightValue');
    
    // Toggle weight controls visibility
    document.getElementById('weightToggleBtn').addEventListener('click', () => {
        const controls = document.getElementById('weightControls');
        controls.style.display = controls.style.display === 'none' ? 'block' : 'none';
    });
    
    // Update display values
    function updateDisplays() {
        volumeValue.textContent = `${volumeSlider.value}%`;
        oiValue.textContent = `${oiSlider.value}%`;
        fundingValue.textContent = `${fundingSlider.value}%`;
        
        // Update total display
        const total = parseInt(volumeSlider.value) + parseInt(oiSlider.value) + parseInt(fundingSlider.value);
        const totalEl = document.getElementById('weightTotal');
        if (totalEl) {
            totalEl.textContent = `${total}%`;
        }
    }
    
    // Adjust other sliders to keep total at 100
    function adjustWeights(changedSlider, otherSlider1, otherSlider2) {
        const changedValue = parseInt(changedSlider.value);
        const remaining = 100 - changedValue;
        
        const other1Current = parseInt(otherSlider1.value);
        const other2Current = parseInt(otherSlider2.value);
        const otherTotal = other1Current + other2Current;
        
        if (otherTotal === 0) {
            otherSlider1.value = Math.floor(remaining / 2);
            otherSlider2.value = remaining - Math.floor(remaining / 2);
        } else {
            const ratio1 = other1Current / otherTotal;
            otherSlider1.value = Math.round(remaining * ratio1);
            otherSlider2.value = remaining - Math.round(remaining * ratio1);
        }
        
        if (parseInt(otherSlider1.value) < 0) otherSlider1.value = 0;
        if (parseInt(otherSlider2.value) < 0) otherSlider2.value = 0;
        
        const total = parseInt(changedSlider.value) + parseInt(otherSlider1.value) + parseInt(otherSlider2.value);
        if (total !== 100) {
            otherSlider2.value = 100 - parseInt(changedSlider.value) - parseInt(otherSlider1.value);
        }
        
        updateDisplays();
    }
    
    volumeSlider.addEventListener('input', () => {
        adjustWeights(volumeSlider, oiSlider, fundingSlider);
    });
    
    oiSlider.addEventListener('input', () => {
        adjustWeights(oiSlider, volumeSlider, fundingSlider);
    });
    
    fundingSlider.addEventListener('input', () => {
        adjustWeights(fundingSlider, volumeSlider, oiSlider);
    });
    
    // Apply weights button
    document.getElementById('applyWeightsBtn').addEventListener('click', () => {
        weights.volume = parseInt(volumeSlider.value);
        weights.oi = parseInt(oiSlider.value);
        weights.funding = parseInt(fundingSlider.value);
        
        recalculateScores();
        currentSort = { column: 'score', direction: 'desc' };
        applyFiltersAndDisplay();
    });
    
    updateDisplays();
}

// Recalculate scores with new weights
function recalculateScores() {
    if (commonPairs.length === 0) return;
    
    const maxVolume = Math.max(...commonPairs.map(p => p.volume24h || 0));
    const maxOI = Math.max(...commonPairs.map(p => p.openInterest || 0));
    const maxFunding = Math.max(...commonPairs.map(p => Math.abs(p.fundingRateAPR || 0)));
    
    commonPairs.forEach(pair => {
        pair.score = calculateScore(pair, maxVolume, maxOI, maxFunding);
    });
    
    commonPairs.sort((a, b) => b.score - a.score);
    commonPairs.forEach((pair, index) => {
        pair.rank = index + 1;
    });
}

// Apply filters and display
function applyFiltersAndDisplay() {
    const searchInput = document.getElementById('searchInput');
    const searchTerm = searchInput.value.toLowerCase().trim();
    
    let filtered = commonPairs;
    if (searchTerm) {
        filtered = commonPairs.filter(pair => 
            pair.ticker.toLowerCase().includes(searchTerm)
        );
    }
    
    displayTable(filtered);
    displayTopCards(sortPairs(commonPairs, 'score', 'desc'));
}

// Fetch all data
async function fetchAllData() {
    const fullLoading = document.getElementById('fullLoading');
    const mainContent = document.getElementById('mainContent');
    const loadingStatus = document.getElementById('loadingStatus');
    const errorMessage = document.getElementById('errorMessage');
    
    fullLoading.style.display = 'flex';
    fullLoading.classList.remove('hidden');
    mainContent.style.display = 'none';
    errorMessage.style.display = 'none';
    
    try {
        loadingStatus.textContent = 'Variational 데이터 수집 중...';
        const variationalData = await fetchVariationalData();
        
        loadingStatus.textContent = 'Lighter 페어 목록 수집 중...';
        const lighterPairs = await fetchLighterPairs();
        
        loadingStatus.textContent = '공통 페어 분석 중...';
        
        const variationalTickers = Object.keys(variationalData);
        const lighterTickers = Array.from(lighterPairs);
        
        console.log('Variational tickers:', variationalTickers.slice(0, 10));
        console.log('Lighter tickers:', lighterTickers.slice(0, 10));
        
        commonPairs = variationalTickers
            .filter(ticker => lighterPairs.has(ticker.toUpperCase()) || lighterPairs.has(ticker))
            .map(ticker => variationalData[ticker]);
        
        console.log(`Found ${commonPairs.length} common pairs`);
        
        if (commonPairs.length > 0) {
            recalculateScores();
        }
        
        console.log(`Stats - Lighter: ${lighterTickers.length}, Variational: ${variationalTickers.length}, Common: ${commonPairs.length}`);
        
        // Display
        displayTable(commonPairs);
        displayTopCards(commonPairs);
        
        loadingStatus.textContent = '완료!';
        setTimeout(() => {
            fullLoading.classList.add('hidden');
            setTimeout(() => {
                fullLoading.style.display = 'none';
            }, 300);
            mainContent.style.display = 'block';
        }, 300);
        
    } catch (error) {
        console.error('Error fetching data:', error);
        loadingStatus.textContent = `오류: ${error.message}`;
        errorMessage.textContent = `데이터 로딩 오류: ${error.message}`;
        errorMessage.style.display = 'block';
        
        setTimeout(() => {
            fullLoading.classList.add('hidden');
            setTimeout(() => {
                fullLoading.style.display = 'none';
            }, 300);
            mainContent.style.display = 'block';
        }, 1000);
    }
}

// Setup refresh button
function setupRefresh() {
    document.getElementById('refreshBtn').addEventListener('click', () => {
        fetchAllData();
    });
}

// Initialize
function initialize() {
    setupSorting();
    setupSearch();
    setupWeightControls();
    setupRefresh();
    fetchAllData();
}

// Start when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize);
} else {
    initialize();
}
