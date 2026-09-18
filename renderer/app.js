const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const flow = ['连接路由器', '自动检查与备份', '启动临时系统', '安装永久系统', '配置网络', '完成验证'];
const actions = {
  flash: { label: '安装 ImmortalWrt', short: '自动检查、备份并安装官方 ImmortalWrt', description: '点击后自动完成检测、安全体检、备份、临时系统、永久安装和重启验证。', group: '安装', icon: '⇩', steps: ['自动检测刷机条件', '校验官方固件', '创建并校验安全备份', '启动临时系统', '安装永久系统', '二次重启验证'] },
  prepare_oem: { label: '准备原厂 1.0.17', short: '获取并校验官方恢复包', description: '为降级或恢复准备小米官方 1.0.17，并用固定 SHA256 验证。', group: '准备', icon: '⬡', steps: ['检查官方资源', '下载原厂 1.0.17', '校验 SHA256', '打开保存位置'] },
  install_oem: { label: '安装原厂 1.0.17', short: '打开后台并选择正确固件', description: '原厂包已经准备完成。软件会打开小米后台和固件目录，引导你完成一次手动安装。', group: '安装', icon: '⇧', steps: ['确认原厂包已准备', '打开小米路由器后台', '选择 BIN 固件并安装', '重启后重新检测'] },
  detect: { label: '重新检测', short: '识别型号、系统与地址', description: '重新读取当前电脑网络和路由器状态，不会修改任何设置。', group: '检测', icon: '↻', steps: ['检查电脑网络', '读取默认网关', '识别设备型号', '确认当前系统'] },
  network: { label: '配置网络', short: '设置上网方式和 Wi-Fi', description: '两步完成上网方式与 Wi-Fi 设置；Wi-Fi 可以跳过，返回上一步不会丢失输入。', group: '配置', icon: '⌘', steps: ['验证设备和密码', '设置 WAN 上网方式', '设置或跳过 Wi-Fi', '保存并重启网络'] },
  backup: { label: '查看安全备份', short: '打开刷机时保存的分区备份', description: '打开刷机前自动创建并校验过的关键分区备份和恢复清单。', group: '维护', icon: '◴', steps: ['核对备份目录', '打开安全备份'] },
  repair: { label: '检查连接问题', short: '识别光猫、地址冲突与错接网线', description: '检查当前电脑实际连接到哪台设备，并给出唯一处理建议。', group: '维护', icon: '✣', steps: ['检查电脑网络', '识别当前网关', '区分光猫与 AX3600', '生成处理建议'] },
};

const state = { device: null, currentAction: null, running: false };
const setupDraft = { wanMode: 'dhcp', pppoeUser: '', pppoePassword: '', lanMode: 'auto', configureWifi: true, wifiSsid: 'AX3600-Home', wifiPassword: '', adminPassword: '' };
let networkPage = 0;

function tone(device) {
  if (!device) return 'checking';
  if (['stock-ready', 'immortalwrt'].includes(device.state)) return 'good';
  if (['stock-downgrade', 'stock-downgrade-ready', 'openwrt-unverified', 'gateway-conflict'].includes(device.state)) return 'warn';
  return 'bad';
}

function mainActionFor(device) {
  if (!device || device.state === 'not-found' || device.state === 'wrong' || device.state === 'openwrt-unverified') return 'detect';
  if (device.state === 'gateway-conflict') return 'repair';
  if (device.state === 'stock-downgrade') return 'prepare_oem';
  if (device.state === 'stock-downgrade-ready') return 'install_oem';
  if (device.state === 'stock-ready') return 'flash';
  return 'network';
}

function allowed(action, device) {
  if (['detect', 'repair'].includes(action)) return true;
  if (!device) return false;
  if (action === 'prepare_oem') return device.state === 'stock-downgrade' || device.state === 'stock-ready';
  if (action === 'install_oem') return device.state === 'stock-downgrade-ready';
  if (action === 'flash') return device.state === 'stock-ready';
  if (['network', 'backup'].includes(action)) return device.state === 'immortalwrt';
  return false;
}

function renderFlow() {
  const device = state.device;
  const installed = device?.state === 'immortalwrt';
  const ready = device?.state === 'stock-ready';
  $('#flowStrip').innerHTML = flow.map((label, index) => {
    const done = installed ? index < 4 : (index === 0 && device && !['not-found', 'wrong', 'gateway-conflict'].includes(device.state));
    const active = installed ? index === 4 : (ready && index === 1);
    return `<div class="flow-item ${done ? 'done' : active ? 'active' : ''}"><span class="flow-number">${done ? '✓' : index + 1}</span><span>${label}</span></div>`;
  }).join('');
}

function renderTools() {
  const ids = state.device?.state === 'immortalwrt' ? ['backup'] : [];
  const main = mainActionFor(state.device);
  $('#toolsSection').classList.toggle('hidden', ids.length === 0);
  $('#toolGrid').innerHTML = ids.filter((id) => id !== main).map((id) => {
    const item = actions[id];
    const enabled = allowed(id, state.device);
    return `<button class="tool-card" data-action="${id}" ${enabled ? '' : 'disabled'}><span class="tool-icon">${item.icon}</span><span class="tool-copy"><strong>${item.label}</strong><span>${enabled ? item.short : '当前状态不可用'}</span></span><span class="tool-arrow">›</span></button>`;
  }).join('');
  $$('[data-action]').forEach((button) => button.addEventListener('click', () => openAction(button.dataset.action)));
}

function renderDevice(device) {
  state.device = device;
  const currentTone = tone(device);
  $('#sideDot').className = `state-dot ${currentTone}`;
  $('#sideState').textContent = device.label;
  $('#sideHint').textContent = device.next;
  $('#headline').textContent = device.headline;
  $('#nextText').textContent = device.next;
  $('#statusPill').className = `status-pill ${currentTone}`;
  $('#statusPill').textContent = device.label;
  $('#deviceModel').textContent = device.model;
  $('#deviceSystem').textContent = device.system;
  $('#deviceVersion').textContent = device.version;
  $('#deviceGateway').textContent = device.gateway;
  const mainId = mainActionFor(device);
  const button = $('#mainAction');
  button.disabled = false;
  button.dataset.action = mainId;
  button.textContent = `${actions[mainId].label}  →`;
  renderFlow();
  renderTools();
}

async function detect() {
  $('#refresh').disabled = true;
  $('#refreshSide').disabled = true;
  $('#sideState').textContent = '正在自动检测';
  $('#statusPill').textContent = '检测中';
  try {
    renderDevice(await window.ax3600.detect());
  } catch (error) {
    renderDevice({ state: 'not-found', label: '检测失败', model: '尚未识别', system: '未知', version: '—', gateway: '未发现', headline: '暂时无法读取路由器状态', next: `请检查网线后重新检测。${error?.message || ''}` });
  } finally {
    $('#refresh').disabled = false;
    $('#refreshSide').disabled = false;
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function saveNetworkDraft() {
  if ($('#networkAdminPassword')) setupDraft.adminPassword = $('#networkAdminPassword').value;
  if ($('#pppoeUser')) setupDraft.pppoeUser = $('#pppoeUser').value;
  if ($('#pppoePassword')) setupDraft.pppoePassword = $('#pppoePassword').value;
  if ($('#wifiSsid')) setupDraft.wifiSsid = $('#wifiSsid').value;
  if ($('#wifiPassword')) setupDraft.wifiPassword = $('#wifiPassword').value;
}

function showFormError(title, message) {
  $('#resultBox').className = 'result-box error';
  $('#resultTitle').textContent = title;
  $('#resultMessage').textContent = message;
}

function renderNetworkWizard() {
  const inputs = $('#actionInputs');
  inputs.classList.remove('hidden');
  $('#resultBox').className = 'result-box hidden';
  if (networkPage === 0) {
    inputs.innerHTML = `<div class="field-heading"><strong>第 1 步：选择上网方式</strong><small>大多数家庭选择自动获取；只有运营商提供了宽带账号时才选 PPPoE。</small></div><div class="choice-grid"><button type="button" class="choice-card ${setupDraft.wanMode === 'dhcp' ? 'selected' : ''}" data-wan="dhcp"><strong>自动获取 DHCP</strong><span>推荐：光猫或上级设备已经拨号</span></button><button type="button" class="choice-card ${setupDraft.wanMode === 'pppoe' ? 'selected' : ''}" data-wan="pppoe"><strong>宽带拨号 PPPoE</strong><span>需要运营商宽带账号和密码</span></button></div>${setupDraft.wanMode === 'pppoe' ? `<label class="input-field"><span>宽带账号</span><input id="pppoeUser" autocomplete="off" value="${escapeHtml(setupDraft.pppoeUser)}"><small>由运营商提供，不是 Wi-Fi 名称。</small></label><label class="input-field"><span>宽带密码</span><input id="pppoePassword" type="password" autocomplete="off" value="${escapeHtml(setupDraft.pppoePassword)}"></label>` : ''}<label class="input-field"><span>ImmortalWrt 管理密码</span><input id="networkAdminPassword" type="password" autocomplete="off" value="${escapeHtml(setupDraft.adminPassword)}"><small>刷机时设置的密码，只保留在本次软件运行内存中。</small></label><div class="field-heading"><strong>AX3600 管理地址</strong><small>不再按某一台电脑或某一种光猫固定修改。</small></div><div class="choice-grid"><button type="button" class="choice-card ${setupDraft.lanMode === 'auto' ? 'selected' : ''}" data-lan="auto"><strong>自动判断（推荐）</strong><span>仅确认 WAN 与 LAN 同网段时改为 192.168.8.1</span></button><button type="button" class="choice-card ${setupDraft.lanMode === 'keep' ? 'selected' : ''}" data-lan="keep"><strong>保持原地址</strong><span>继续使用当前管理地址，不自动修改</span></button><button type="button" class="choice-card ${setupDraft.lanMode === 'change' ? 'selected' : ''}" data-lan="change"><strong>固定改为 192.168.8.1</strong><span>仅在你明确需要该地址时选择</span></button></div>`;
    $$('[data-wan]').forEach((button) => button.addEventListener('click', () => {
      saveNetworkDraft();
      setupDraft.wanMode = button.dataset.wan;
      renderNetworkWizard();
    }));
    $$('[data-lan]').forEach((button) => button.addEventListener('click', () => {
      saveNetworkDraft();
      setupDraft.lanMode = button.dataset.lan;
      renderNetworkWizard();
    }));
  } else {
    inputs.innerHTML = `<div class="field-heading"><strong>第 2 步：设置 Wi-Fi</strong><small>可以暂时跳过，以后再次打开“配置网络”即可设置。</small></div><button type="button" class="toggle-row ${setupDraft.configureWifi ? 'selected' : ''}" id="wifiToggle"><span><strong>${setupDraft.configureWifi ? '设置 Wi-Fi' : '暂时跳过 Wi-Fi'}</strong><small>${setupDraft.configureWifi ? '同时设置前两个无线频段的名称和密码' : '保留路由器当前无线设置'}</small></span><b>${setupDraft.configureWifi ? '已开启' : '已跳过'}</b></button>${setupDraft.configureWifi ? `<label class="input-field"><span>Wi-Fi 名称</span><input id="wifiSsid" autocomplete="off" value="${escapeHtml(setupDraft.wifiSsid)}"></label><label class="input-field"><span>Wi-Fi 密码</span><input id="wifiPassword" type="password" autocomplete="off" value="${escapeHtml(setupDraft.wifiPassword)}"><small>8–63 位；返回上一步后内容仍会保留。</small></label>` : ''}`;
    $('#wifiToggle').addEventListener('click', () => {
      saveNetworkDraft();
      setupDraft.configureWifi = !setupDraft.configureWifi;
      renderNetworkWizard();
    });
  }
  $('#modalBack').classList.toggle('hidden', networkPage === 0);
  $('#modalRun').textContent = networkPage === 0 ? '下一步' : '应用设置';
}

function nextNetworkPage() {
  saveNetworkDraft();
  if (!setupDraft.adminPassword) return showFormError('请填写管理密码', '请输入刷机时设置的 ImmortalWrt 管理密码。');
  if (setupDraft.wanMode === 'pppoe' && (!setupDraft.pppoeUser.trim() || !setupDraft.pppoePassword)) return showFormError('请填写宽带账号', 'PPPoE 必须填写运营商提供的宽带账号和密码。');
  networkPage = 1;
  renderNetworkWizard();
}

function previousNetworkPage() {
  saveNetworkDraft();
  networkPage = 0;
  renderNetworkWizard();
}

function openAction(id) {
  if (!actions[id] || state.running) return;
  state.currentAction = id;
  const action = actions[id];
  $('#modalTag').textContent = action.group;
  $('#modalTitle').textContent = action.label;
  $('#modalDescription').textContent = action.description;
  const inputs = $('#actionInputs');
  if (id === 'flash') {
    inputs.innerHTML = `<label class="input-field"><span>小米后台完整地址</span><input id="stockUrl" autocomplete="off" placeholder="登录后台后粘贴包含 ;stok= 的完整地址"><small>只用于本次建立一次性连接，不写入日志。</small></label><label class="input-field"><span>新的 ImmortalWrt 管理密码</span><input id="adminPassword" type="password" autocomplete="new-password" placeholder="10–64 位字母、数字或常用符号"><small>安装完成后用于登录 ImmortalWrt；软件不会保存密码。</small></label>`;
    inputs.classList.remove('hidden');
  } else if (id === 'network') {
    networkPage = 0;
    renderNetworkWizard();
  } else {
    inputs.innerHTML = '';
    inputs.classList.add('hidden');
  }
  $('#stepGrid').innerHTML = action.steps.map((step, index) => `<div class="step" data-step="${index}"><span>${index + 1}</span><b>${step}</b></div>`).join('');
  $('#progressBox').classList.add('hidden');
  $('#resultBox').className = 'result-box hidden';
  $('#modalRun').disabled = false;
  $('#modalBack').classList.add('hidden');
  $('#modalRun').textContent = id === 'flash' ? '开始安装' : id === 'install_oem' ? '打开下一步' : '开始执行';
  $('#modalBackdrop').classList.remove('hidden');
  if (id === 'network') renderNetworkWizard();
}

function closeModal() {
  if (state.running) return;
  if (state.currentAction === 'network') saveNetworkDraft();
  $('#modalBackdrop').classList.add('hidden');
  state.currentAction = null;
}

async function runCurrent() {
  const id = state.currentAction;
  if (!id || state.running) return;
  state.running = true;
  $('#modalRun').disabled = true;
  $('#modalRun').textContent = '正在执行…';
  $('#modalCancel').disabled = true;
  $('#modalBack').disabled = true;
  $('#progressBox').classList.remove('hidden');
  $('#resultBox').classList.add('hidden');
  $('#runState').textContent = '运行中';
  try {
    if (id === 'network') saveNetworkDraft();
    const payload = id === 'flash'
      ? { stockUrl: $('#stockUrl')?.value || '', adminPassword: $('#adminPassword')?.value || '' }
      : id === 'network' ? { ...setupDraft } : {};
    if (id === 'flash' && payload.adminPassword) setupDraft.adminPassword = payload.adminPassword;
    const result = await window.ax3600.runAction(id, payload);
    $('#resultBox').className = `result-box ${result.ok ? (result.warning ? 'warning' : 'success') : 'error'}`;
    $('#resultTitle').textContent = result.title;
    $('#resultMessage').textContent = result.message;
    $('#progressTitle').textContent = result.ok ? '已完成' : '已安全停止';
    $('#runState').textContent = result.ok ? '完成' : '已停止';
    if (result.device) renderDevice(result.device);
    if (id === 'detect' || id === 'prepare_oem') await detect();
  } catch (error) {
    $('#resultBox').className = 'result-box error';
    $('#resultTitle').textContent = '执行失败';
    $('#resultMessage').textContent = error?.message || '未知错误';
    $('#runState').textContent = '失败';
  } finally {
    state.running = false;
    $('#modalRun').disabled = false;
    $('#modalRun').textContent = '再执行一次';
    $('#modalCancel').disabled = false;
    $('#modalBack').disabled = false;
  }
}

window.ax3600.onProgress((event) => {
  if (event.action !== state.currentAction) return;
  $('#progressTitle').textContent = event.message;
  $('#progressMessage').textContent = event.status === 'error' ? '发现问题，软件已停止；没有继续执行危险操作。' : '请保持路由器和电脑供电、网络连接稳定。';
  $('#progressPercent').textContent = `${event.percent}%`;
  $('#runPercent').textContent = `${event.percent}%`;
  $('#progressFill').style.width = `${event.percent}%`;
  $$('.step').forEach((step, index) => {
    step.className = `step ${index < event.index ? 'done' : index === event.index ? (event.status === 'error' ? 'error' : 'active') : ''}`;
    if (index < event.index) step.querySelector('span').textContent = '✓';
  });
});

$('#refresh').addEventListener('click', detect);
$('#refreshSide').addEventListener('click', detect);
$('#mainAction').addEventListener('click', () => openAction($('#mainAction').dataset.action));
$('#modalClose').addEventListener('click', closeModal);
$('#modalCancel').addEventListener('click', closeModal);
$('#modalBack').addEventListener('click', previousNetworkPage);
$('#modalRun').addEventListener('click', () => {
  if (state.currentAction === 'network' && networkPage === 0 && !state.running) nextNetworkPage();
  else runCurrent();
});
$('#modalBackdrop').addEventListener('click', (event) => { if (event.target === $('#modalBackdrop')) closeModal(); });
$$('[data-folder]').forEach((button) => button.addEventListener('click', () => window.ax3600.openFolder(button.dataset.folder)));

window.ax3600.getAppInfo().then((info) => { $('#version').textContent = `V${info.version}`; });
renderFlow();
renderTools();
detect();
