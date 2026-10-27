/* Browser-only remote login viewer. Coordinates come from real pointer input. */
const screen = document.querySelector('#screen'), ctx = screen.getContext('2d');
const label = document.querySelector('#status'), detail = document.querySelector('#detail'), error = document.querySelector('#error');
const storageKey = `xhs-login:${location.pathname}`;
const token = new URLSearchParams(location.hash.slice(1)).get('token') || sessionStorage.getItem(storageKey);
if (token) sessionStorage.setItem(storageKey, token);
history.replaceState(null, '', location.pathname);
const names = { starting: '正在打开小红书页面', waiting_for_scan: '等待扫码及手机确认', waiting_for_verification: '需要站点验证，请在下方页面操作', waiting_for_login: '等待站点完成登录', authenticated: '浏览器登录成功', failed: '登录失败', expired: '登录已超时', cancelled: '登录已取消' };
const terminal = new Set(['authenticated', 'failed', 'expired', 'cancelled']);
let stopped = false, activePointer, queue = [], sending = false;
async function call(action, body) {
  const response = await fetch(new URL(action, location.href), { headers: { Authorization: `Bearer ${token ?? ''}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', signal: AbortSignal.timeout(6000) });
  if (!response.ok) throw new Error(response.status === 401 ? '入口凭证无效，请使用程序返回的完整链接。' : response.status === 410 ? '本次登录操作已结束。' : '暂时无法操作页面，请稍后重试。');
  return response;
}
function enqueue(event) {
  if (stopped) return;
  if (queue.length >= 128) { queue = queue.filter(v => v.type !== 'move'); }
  queue.push(event); void flush();
}
async function flush() {
  if (sending || !queue.length || stopped) return;
  sending = true;
  const events = queue.splice(0, 32);
  try { await call('input', { events }); error.textContent = ''; }
  catch (e) { queue = []; error.textContent = e.message; }
  finally { sending = false; if (queue.length) void flush(); }
}
function move(event) {
  const rect = screen.getBoundingClientRect();
  const x = Math.min(1279, Math.max(0, (event.clientX - rect.left) * 1280 / rect.width));
  const y = Math.min(799, Math.max(0, (event.clientY - rect.top) * 800 / rect.height));
  enqueue({ type: 'move', x, y });
}
screen.addEventListener('pointerdown', event => {
  if (activePointer !== undefined || event.button !== 0) return;
  event.preventDefault(); screen.focus(); activePointer = event.pointerId; screen.setPointerCapture(event.pointerId);
  move(event); enqueue({ type: 'down' });
});
screen.addEventListener('pointermove', event => { if (activePointer === undefined || activePointer === event.pointerId) move(event); });
function release(event) {
  if (activePointer !== event.pointerId) return;
  move(event); enqueue({ type: 'up' }); activePointer = undefined;
}
screen.addEventListener('pointerup', release); screen.addEventListener('pointercancel', release);
screen.addEventListener('lostpointercapture', event => { if (activePointer === event.pointerId) { enqueue({ type: 'up' }); activePointer = undefined; } });
window.addEventListener('blur', () => { if (activePointer !== undefined) { enqueue({ type: 'up' }); activePointer = undefined; } });
screen.addEventListener('wheel', event => { event.preventDefault(); enqueue({ type: 'wheel', deltaX: Math.max(-2000, Math.min(2000, event.deltaX)), deltaY: Math.max(-2000, Math.min(2000, event.deltaY)) }); }, { passive: false });
const keys = new Set(['Tab', 'Enter', 'Escape', 'Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']);
screen.addEventListener('keydown', event => {
  event.preventDefault();
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') enqueue({ type: 'key', key: event.metaKey ? 'Meta+A' : 'Control+A' });
  else if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key === ' ') enqueue({ type: 'key', key: 'Space' });
  else if (!event.ctrlKey && !event.metaKey && !event.altKey && keys.has(event.key)) enqueue({ type: 'key', key: event.shiftKey && event.key === 'Tab' ? 'Shift+Tab' : event.key });
  else if (!event.isComposing && !event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1) enqueue({ type: 'text', text: event.key });
});
screen.addEventListener('contextmenu', event => event.preventDefault());
document.querySelector('#send').addEventListener('click', () => { const field = document.querySelector('#text'); if (field.value) { enqueue({ type: 'text', text: field.value }); field.value = ''; screen.focus(); } });
document.querySelector('#complete').addEventListener('click', async () => { try { await call('complete',{}); detail.textContent='正在检查浏览器状态；接口恢复情况将由机器人私聊通知。'; } catch(e) { error.textContent=e.message; } });
document.querySelector('#cancel').addEventListener('click', async () => { try { await call('cancel', {}); stopped = true; queue = []; label.textContent = names.cancelled; sessionStorage.removeItem(storageKey); } catch (e) { error.textContent = e.message; } });
async function refresh() {
  if (stopped) return;
  try {
    const state = await (await call('status')).json();
    if (state.mode === 'verification') { document.querySelector('h1').textContent='小红书人工验证'; document.title='小红书人工验证'; document.querySelector('#complete').hidden=false; document.querySelector('#cancel').textContent='取消验证'; detail.textContent='使用已有登录态打开站点页面。若出现验证，请人工操作；确认完成后点击“验证已完成，检查并保存”。网页已登录不代表搜索API已恢复。'; }
    label.textContent = names[state.status] ?? state.status;
    if (terminal.has(state.status)) {
      stopped = true; queue = []; sessionStorage.removeItem(storageKey);
      detail.textContent = state.status === 'authenticated' ? '浏览器登录步骤已完成。最终会话保存和 HTTP 核验结果请查看调用方返回值。' : `本次登录已结束${state.error ? '：' + state.error.code : ''}。`;
      return;
    }
    const image = await createImageBitmap(await (await call('frame')).blob()); ctx.drawImage(image, 0, 0, 1280, 800); image.close();
    error.textContent = '';
  } catch (e) { error.textContent = `${e.message} 若登录任务已结束，请查看调用方返回值。`; }
  setTimeout(refresh, document.hidden ? 1500 : 400);
}
if (!token) { stopped = true; label.textContent = '缺少入口凭证'; error.textContent = '请打开程序返回的完整 interaction_url。'; }
else void refresh();
