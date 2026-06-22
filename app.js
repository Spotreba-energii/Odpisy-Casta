// ── FIREBASE INIT ──
import { initializeApp }                          from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getFirestore, collection, doc,
         addDoc, deleteDoc, setDoc, getDoc,
         onSnapshot, query, orderBy }             from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseConfig }                         from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const db  = getFirestore(app);

// ── IN-MEMORY CACHE (filled by Firestore listeners) ──
const cache = { water: [], gas: [] };
let prices  = { water: 2.5, gas: 0.085 };

// ── SYNC STATUS ──
function setSyncStatus(state) {
  const el = document.getElementById('syncStatus');
  el.className = 'sync-status ' + state;
  el.title = { ok: 'Synchronizované', syncing: 'Synchronizujem...', error: 'Chyba spojenia' }[state] || '';
}

// ── FIRESTORE LISTENERS (real-time) ──
function startListeners() {
  setSyncStatus('syncing');

  const wq = query(collection(db, 'readings_water'), orderBy('date'));
  onSnapshot(wq, snap => {
    cache.water = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderAll();
    setSyncStatus('ok');
  }, () => setSyncStatus('error'));

  const gq = query(collection(db, 'readings_gas'), orderBy('date'));
  onSnapshot(gq, snap => {
    cache.gas = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderAll();
    setSyncStatus('ok');
  }, () => setSyncStatus('error'));

  // Prices doc
  const pricesRef = doc(db, 'config', 'prices');
  onSnapshot(pricesRef, snap => {
    if (snap.exists()) {
      prices = snap.data();
      loadPricesUI();
      renderAll();
    }
  });
}

// ── SAVE READING ──
async function saveReading(type) {
  const prefix   = type === 'water' ? 'w' : 'g';
  const dateEl   = document.getElementById(prefix + '-date');
  const valEl    = document.getElementById(prefix + '-value');
  const noteEl   = document.getElementById(prefix + '-note');
  const hintEl   = document.getElementById(prefix + '-hint');

  const date = dateEl.value;
  const val  = parseFloat(valEl.value);
  const note = noteEl.value.trim();

  if (!date) { showHint(hintEl, '⚠ Zadajte dátum.', 'error'); return; }
  if (isNaN(val) || val < 0) { showHint(hintEl, '⚠ Zadajte platný stav meraču.', 'error'); return; }

  const arr  = cache[type];
  const last = arr[arr.length - 1];
  if (last && val < last.value) {
    showHint(hintEl, `⚠ Stav je nižší ako predošlý (${last.value} m³). Skontrolujte hodnotu.`, 'error');
    return;
  }
  if (last && last.date === date) {
    showHint(hintEl, '⚠ Záznam pre tento dátum už existuje.', 'error');
    return;
  }

  setSyncStatus('syncing');
  try {
    const colName = type === 'water' ? 'readings_water' : 'readings_gas';
    await addDoc(collection(db, colName), { date, value: val, note, createdAt: new Date().toISOString() });
    valEl.value  = '';
    noteEl.value = '';
    showHint(hintEl, '✓ Uložené!', 'ok');
  } catch (e) {
    showHint(hintEl, '✗ Chyba uloženia: ' + e.message, 'error');
    setSyncStatus('error');
  }
}

// ── DELETE READING ──
async function deleteReading(type, docId) {
  if (!confirm('Zmazať tento záznam?')) return;
  const colName = type === 'water' ? 'readings_water' : 'readings_gas';
  setSyncStatus('syncing');
  try {
    await deleteDoc(doc(db, colName, docId));
  } catch (e) {
    alert('Chyba mazania: ' + e.message);
    setSyncStatus('error');
  }
}

// ── SAVE PRICES ──
async function savePrices() {
  const pw = parseFloat(document.getElementById('price-water').value);
  const pg = parseFloat(document.getElementById('price-gas').value);
  if (!isNaN(pw) && pw > 0 && !isNaN(pg) && pg > 0) {
    setSyncStatus('syncing');
    try {
      await setDoc(doc(db, 'config', 'prices'), { water: pw, gas: pg });
      alert('Ceny uložené.');
    } catch (e) {
      alert('Chyba: ' + e.message);
      setSyncStatus('error');
    }
  }
}

// ── EXPORT / IMPORT ──
function exportData() {
  const blob = new Blob([JSON.stringify({ readings: cache, prices, exported: new Date().toISOString() }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'meraci_zaloha_' + new Date().toISOString().slice(0, 10) + '.json';
  a.click();
}

async function importData(e) {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  try {
    const obj = JSON.parse(text);
    if (!obj.readings?.water || !obj.readings?.gas) { alert('Neplatný formát súboru.'); return; }
    if (!confirm(`Importovať ${obj.readings.water.length} vodomerov a ${obj.readings.gas.length} plynomerov?`)) return;
    setSyncStatus('syncing');
    for (const r of obj.readings.water) {
      const { id, ...data } = r;
      await addDoc(collection(db, 'readings_water'), data);
    }
    for (const r of obj.readings.gas) {
      const { id, ...data } = r;
      await addDoc(collection(db, 'readings_gas'), data);
    }
    if (obj.prices) await setDoc(doc(db, 'config', 'prices'), obj.prices);
    alert('Import úspešný!');
  } catch (err) {
    alert('Chyba importu: ' + err.message);
    setSyncStatus('error');
  }
  e.target.value = '';
}

async function clearAll() {
  closeConfirm();
  setSyncStatus('syncing');
  try {
    for (const r of [...cache.water]) await deleteDoc(doc(db, 'readings_water', r.id));
    for (const r of [...cache.gas])   await deleteDoc(doc(db, 'readings_gas',   r.id));
  } catch (e) {
    alert('Chyba mazania: ' + e.message);
    setSyncStatus('error');
  }
}

// ── COMPUTATIONS ──
function computeConsumption(arr) {
  return arr.map((r, i) => {
    if (i === 0) return { ...r, consumption: null, days: null };
    const prev = arr[i - 1];
    return { ...r, consumption: +(r.value - prev.value).toFixed(3), days: Math.round((new Date(r.date) - new Date(prev.date)) / 86400000) };
  });
}

function groupByMonth(arr) {
  const m = {};
  computeConsumption(arr).forEach(r => {
    if (r.consumption === null) return;
    const k = r.date.slice(0, 7);
    m[k] = (m[k] || 0) + r.consumption;
  });
  return m;
}

function groupByYear(arr) {
  const y = {};
  computeConsumption(arr).forEach(r => {
    if (r.consumption === null) return;
    const k = r.date.slice(0, 4);
    y[k] = +((y[k] || 0) + r.consumption).toFixed(3);
  });
  return y;
}

function getLast12Months() {
  const months = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(d.toISOString().slice(0, 7));
  }
  return months;
}

// ── TABS ──
function switchTab(name, btn) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  // activate the correct nav button
  const target = btn || document.querySelector(`.nav-btn[data-tab="${name}"]`);
  if (target) target.classList.add('active');
  renderAll();
}

// ── CHART MODE ──
let chartMode = 'both';
function setChartMode(mode, el) {
  chartMode = mode;
  document.querySelectorAll('.toggle-pill').forEach(p => p.classList.remove('active', 'water', 'gas', 'both'));
  el.classList.add('active', mode);
  renderMonthChart();
}

// ── RENDER ALL ──
let monthChart = null, yearChart = null, heatWaterChart = null, heatGasChart = null, dailyChart = null;

function renderAll() {
  renderStats();
  renderMonthChart();
  renderYearChart();
  renderLastReadings();
  renderHistory();
  renderAnalysis();
  populateYearFilter();
}

function loadPricesUI() {
  document.getElementById('price-water').value = prices.water;
  document.getElementById('price-gas').value   = prices.gas;
}

// ── STATS ──
function renderStats() {
  const wc   = computeConsumption(cache.water);
  const gc   = computeConsumption(cache.gas);
  const lastW = wc.filter(r => r.consumption !== null).slice(-1)[0];
  const lastG = gc.filter(r => r.consumption !== null).slice(-1)[0];
  const prevW = wc.filter(r => r.consumption !== null).slice(-2)[0];
  const prevG = gc.filter(r => r.consumption !== null).slice(-2)[0];
  const wYear = groupByYear(cache.water);
  const gYear = groupByYear(cache.gas);
  const thisYear = new Date().getFullYear().toString();

  function deltaHtml(curr, prev) {
    if (!curr || !prev || curr.consumption === null || prev.consumption === null) return '';
    const diff = curr.consumption - prev.consumption;
    const pct  = prev.consumption > 0 ? Math.round(Math.abs(diff) / prev.consumption * 100) : 0;
    if (Math.abs(diff) < 0.001) return '<span class="delta neutral">= rovnaké</span>';
    const cls  = diff > 0 ? 'up' : 'down';
    const arrow = diff > 0 ? '▲' : '▼';
    return `<span class="delta ${cls}">${arrow} ${Math.abs(diff).toFixed(2)} m³ (${pct}%)</span>`;
  }

  document.getElementById('statsGrid').innerHTML = `
    <div class="stat-card water">
      <div class="stat-label">Posledná spotreba — voda</div>
      <div class="stat-value water">${lastW ? lastW.consumption.toFixed(2) : '—'}<span class="stat-unit">m³</span></div>
      <div class="stat-sub">${lastW ? lastW.date : 'Žiadne záznamy'}</div>
      ${deltaHtml(lastW, prevW)}
    </div>
    <div class="stat-card gas">
      <div class="stat-label">Posledná spotreba — plyn</div>
      <div class="stat-value gas">${lastG ? lastG.consumption.toFixed(2) : '—'}<span class="stat-unit">m³</span></div>
      <div class="stat-sub">${lastG ? lastG.date : 'Žiadne záznamy'}</div>
      ${deltaHtml(lastG, prevG)}
    </div>
    <div class="stat-card water">
      <div class="stat-label">Voda ${thisYear} (náklady)</div>
      <div class="stat-value water">${((wYear[thisYear]||0)*prices.water).toFixed(2)}<span class="stat-unit">€</span></div>
      <div class="stat-sub">${(wYear[thisYear]||0).toFixed(2)} m³ celkom</div>
    </div>
    <div class="stat-card gas">
      <div class="stat-label">Plyn ${thisYear} (náklady)</div>
      <div class="stat-value gas">${((gYear[thisYear]||0)*prices.gas).toFixed(2)}<span class="stat-unit">€</span></div>
      <div class="stat-sub">${(gYear[thisYear]||0).toFixed(2)} m³ celkom</div>
    </div>
  `;
}

// ── MONTH CHART ──
function renderMonthChart() {
  const months  = getLast12Months();
  const wMonth  = groupByMonth(cache.water);
  const gMonth  = groupByMonth(cache.gas);
  const labels  = months.map(m => {
    const [y, mo] = m.split('-');
    return ['Jan','Feb','Mar','Apr','Máj','Jún','Júl','Aug','Sep','Okt','Nov','Dec'][parseInt(mo)-1] + ' ' + y.slice(2);
  });

  const datasets = [];
  if (chartMode !== 'gas')   datasets.push({ label: 'Voda (m³)', data: months.map(m => +(wMonth[m]||0).toFixed(3)), backgroundColor: '#1a7fc4cc', borderColor: '#1a7fc4', borderWidth: 2, borderRadius: 4, yAxisID: 'y' });
  if (chartMode !== 'water') datasets.push({ label: 'Plyn (m³)', data: months.map(m => +(gMonth[m]||0).toFixed(3)), backgroundColor: '#c46a1acc', borderColor: '#c46a1a', borderWidth: 2, borderRadius: 4, yAxisID: chartMode === 'both' ? 'y1' : 'y' });

  const scales = { x: { grid: { color: 'rgba(128,128,128,0.1)' }, ticks: { autoSkip: false, maxRotation: 45 } } };
  if (chartMode === 'both') {
    scales.y  = { type:'linear', position:'left',  title:{display:true,text:'Voda (m³)',color:'#1a7fc4'}, grid:{color:'rgba(128,128,128,0.1)'} };
    scales.y1 = { type:'linear', position:'right', title:{display:true,text:'Plyn (m³)',color:'#c46a1a'}, grid:{drawOnChartArea:false} };
  } else {
    scales.y = { beginAtZero: true, grid: { color: 'rgba(128,128,128,0.1)' } };
  }

  if (monthChart) monthChart.destroy();
  monthChart = new Chart(document.getElementById('monthChart'), {
    type: 'bar', data: { labels, datasets },
    options: { responsive:true, maintainAspectRatio:false, plugins:{legend:{display:true,position:'top',labels:{boxWidth:12,font:{size:12}}}}, scales }
  });
}

// ── YEAR CHART ──
function renderYearChart() {
  const wYear = groupByYear(cache.water);
  const gYear = groupByYear(cache.gas);
  const allYears = [...new Set([...Object.keys(wYear),...Object.keys(gYear)])].sort();
  if (yearChart) yearChart.destroy();
  yearChart = new Chart(document.getElementById('yearChart'), {
    type: 'bar',
    data: { labels: allYears, datasets: [
      { label:'Voda (m³)', data:allYears.map(y=>wYear[y]||0), backgroundColor:'#1a7fc4bb', borderColor:'#1a7fc4', borderWidth:2, borderRadius:4 },
      { label:'Plyn (m³)', data:allYears.map(y=>gYear[y]||0), backgroundColor:'#c46a1abb', borderColor:'#c46a1a', borderWidth:2, borderRadius:4 }
    ]},
    options: { responsive:true, maintainAspectRatio:false, plugins:{legend:{display:true,position:'top',labels:{boxWidth:12,font:{size:12}}}}, scales:{y:{beginAtZero:true,grid:{color:'rgba(128,128,128,0.1)'}},x:{grid:{color:'rgba(128,128,128,0.1)'}}} }
  });
}

// ── LAST READINGS ──
function renderLastReadings() {
  function html(arr, type) {
    const computed = computeConsumption(arr).slice(-4).reverse();
    if (!computed.length) return `<div class="empty-state" style="padding:1rem"><div class="empty-icon">${type==='water'?'💧':'🔥'}</div><div>Žiadne záznamy</div></div>`;
    return computed.map(r => `
      <div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--c-border);font-size:13px">
        <div style="color:var(--c-muted)">${r.date}</div>
        <div><strong>${r.value.toFixed(type==='water'?3:2)}</strong> m³</div>
        <div style="color:${type==='water'?'var(--c-water)':'var(--c-gas)'}">
          ${r.consumption !== null ? '+'+r.consumption.toFixed(type==='water'?3:2)+' m³' : '—'}
        </div>
      </div>`).join('') + '<div style="height:2px"></div>';
  }
  document.getElementById('lastWater').innerHTML = html(cache.water, 'water');
  document.getElementById('lastGas').innerHTML   = html(cache.gas,   'gas');
}

// ── YEAR FILTER ──
function populateYearFilter() {
  const years = new Set([...cache.water,...cache.gas].map(r => r.date.slice(0,4)));
  const sel   = document.getElementById('filterYear');
  const cur   = sel.value;
  sel.innerHTML = '<option value="all">Všetky roky</option>';
  [...years].sort().reverse().forEach(y => { sel.innerHTML += `<option value="${y}"${cur===y?' selected':''}>${y}</option>`; });
}

// ── HISTORY ──
function renderHistory() {
  const type  = document.getElementById('filterType').value;
  const year  = document.getElementById('filterYear').value;
  const wc    = computeConsumption(cache.water).map(r => ({ ...r, type:'water' }));
  const gc    = computeConsumption(cache.gas).map(r =>   ({ ...r, type:'gas'   }));
  let rows    = [];
  if (type !== 'gas')   rows = rows.concat(wc);
  if (type !== 'water') rows = rows.concat(gc);
  rows.sort((a,b) => b.date.localeCompare(a.date));
  if (year !== 'all') rows = rows.filter(r => r.date.startsWith(year));

  const tbody = document.getElementById('historyBody');
  if (!rows.length) { tbody.innerHTML = '<tr><td colspan="8"><div class="empty-state">Žiadne záznamy</div></td></tr>'; return; }

  tbody.innerHTML = rows.map(r => {
    const isW   = r.type === 'water';
    const price = r.consumption !== null ? (r.consumption * (isW ? prices.water : prices.gas)).toFixed(2) : '—';
    return `<tr>
      <td>${r.date}</td>
      <td><span class="badge ${r.type}">${isW ? '💧 Voda' : '🔥 Plyn'}</span></td>
      <td>${r.value.toFixed(isW?3:2)}</td>
      <td>${r.consumption !== null ? r.consumption.toFixed(isW?3:2) : '—'}</td>
      <td>${r.days !== null ? r.days : '—'}</td>
      <td>${price !== '—' ? price+' €' : '—'}</td>
      <td><span class="note-text">${r.note||''}</span></td>
      <td><button class="btn btn-danger btn-sm" onclick="window.__deleteReading('${r.type}','${r.id}')">✕</button></td>
    </tr>`;
  }).join('');
}

// ── ANALYSIS ──
function renderAnalysis() {
  const wYear    = groupByYear(cache.water);
  const gYear    = groupByYear(cache.gas);
  const allYears = [...new Set([...Object.keys(wYear),...Object.keys(gYear)])].sort().reverse();

  // Comparison table
  let tableHtml = '';
  if (allYears.length > 0) {
    tableHtml = `<table class="comp-table"><thead><tr><th>Rok</th>${allYears.map(y=>`<th>${y}</th>`).join('')}</tr></thead><tbody>`;
    tableHtml += `<tr><td>💧 Voda (m³)</td>${allYears.map(y=>`<td>${(wYear[y]||0).toFixed(2)}</td>`).join('')}</tr>`;
    tableHtml += `<tr><td>💧 Náklady voda</td>${allYears.map(y=>`<td>${((wYear[y]||0)*prices.water).toFixed(0)} €</td>`).join('')}</tr>`;
    tableHtml += `<tr><td>🔥 Plyn (m³)</td>${allYears.map(y=>`<td>${(gYear[y]||0).toFixed(2)}</td>`).join('')}</tr>`;
    tableHtml += `<tr><td>🔥 Náklady plyn</td>${allYears.map(y=>`<td>${((gYear[y]||0)*prices.gas).toFixed(0)} €</td>`).join('')}</tr>`;
    tableHtml += `<tr class="total-row"><td>Celkom (€)</td>${allYears.map(y=>`<td>${((wYear[y]||0)*prices.water+(gYear[y]||0)*prices.gas).toFixed(0)} €</td>`).join('')}</tr>`;
    tableHtml += '</tbody></table>';
  } else {
    tableHtml = '<div class="empty-state">Žiadne dáta na porovnanie</div>';
  }
  document.getElementById('yearCompWrap').innerHTML = tableHtml;

  // Monthly breakdown charts
  const months       = ['Jan','Feb','Mar','Apr','Máj','Jún','Júl','Aug','Sep','Okt','Nov','Dec'];
  const wMonth       = groupByMonth(cache.water);
  const gMonth       = groupByMonth(cache.gas);
  const displayYears = allYears.slice(0,3).reverse();
  const wColors      = ['#1a7fc4','#5aaedb','#aacfed'];
  const gColors      = ['#c46a1a','#e8943a','#f0c090'];

  function mkDatasets(monthlyMap, yearList, colorArr) {
    return yearList.map((y,i) => ({
      label: y, borderRadius: 3,
      data: months.map((_,mi) => +(monthlyMap[y+'-'+String(mi+1).padStart(2,'0')]||0).toFixed(2)),
      backgroundColor: colorArr[i]+'bb', borderColor: colorArr[i], borderWidth: 1.5
    }));
  }
  const chartOpts = { responsive:true, maintainAspectRatio:false, plugins:{legend:{display:true,position:'top',labels:{boxWidth:10,font:{size:11}}}}, scales:{y:{beginAtZero:true,grid:{color:'rgba(128,128,128,0.1)'}},x:{grid:{color:'rgba(128,128,128,0.1)'},ticks:{autoSkip:false}}} };

  if (heatWaterChart) heatWaterChart.destroy();
  heatWaterChart = new Chart(document.getElementById('heatWater'), { type:'bar', data:{ labels:months, datasets:mkDatasets(wMonth,displayYears,wColors) }, options:chartOpts });

  if (heatGasChart) heatGasChart.destroy();
  heatGasChart = new Chart(document.getElementById('heatGas'), { type:'bar', data:{ labels:months, datasets:mkDatasets(gMonth,displayYears,gColors) }, options:chartOpts });

  // Daily average trend
  const wComp = computeConsumption(cache.water).filter(r => r.consumption!==null && r.days>0);
  const gComp = computeConsumption(cache.gas).filter(r   => r.consumption!==null && r.days>0);
  if (dailyChart) dailyChart.destroy();
  dailyChart = new Chart(document.getElementById('dailyChart'), {
    type:'line',
    data:{ datasets:[
      { label:'Voda (l/deň)', data:wComp.map(r=>({x:r.date,y:+(r.consumption*1000/r.days).toFixed(1)})), borderColor:'#1a7fc4', backgroundColor:'#1a7fc422', tension:0.3, pointRadius:4, fill:true, yAxisID:'y' },
      { label:'Plyn (m³/deň)', data:gComp.map(r=>({x:r.date,y:+(r.consumption/r.days).toFixed(3)})),    borderColor:'#c46a1a', backgroundColor:'#c46a1a22', tension:0.3, pointRadius:4, fill:true, yAxisID:'y1' }
    ]},
    options:{ responsive:true, maintainAspectRatio:false,
      plugins:{legend:{display:true,position:'top',labels:{boxWidth:10,font:{size:12}}}},
      scales:{
        x:{type:'category',grid:{color:'rgba(128,128,128,0.1)'}},
        y:{position:'left', title:{display:true,text:'Voda (l/deň)',color:'#1a7fc4'}, grid:{color:'rgba(128,128,128,0.1)'}},
        y1:{position:'right',title:{display:true,text:'Plyn (m³/deň)',color:'#c46a1a'},grid:{drawOnChartArea:false}}
      }
    }
  });
}

// ── HELPERS ──
function showHint(el, msg, type) {
  el.textContent = msg;
  el.style.color = type === 'ok' ? 'var(--c-success)' : 'var(--c-danger)';
  if (type === 'ok') setTimeout(() => { el.textContent = ''; }, 2500);
}

function confirmClear() { document.getElementById('confirmOverlay').classList.add('show'); }
function closeConfirm() { document.getElementById('confirmOverlay').classList.remove('show'); }

function todayStr() { return new Date().toISOString().slice(0,10); }

// ── EXPOSE TO HTML ──
window.switchTab    = switchTab;
window.setChartMode = setChartMode;
window.saveReading  = saveReading;
window.savePrices   = savePrices;
window.exportData   = exportData;
window.importData   = importData;
window.confirmClear = confirmClear;
window.closeConfirm = closeConfirm;
window.clearAll     = clearAll;
window.__deleteReading = deleteReading;

// ── INIT ──
document.getElementById('w-date').value = todayStr();
document.getElementById('g-date').value = todayStr();
startListeners();
