import assert from 'node:assert';
import { app, prisma, server } from '../src/server.js';

const PORT = 3000;
const BASE_URL = `http://localhost:${PORT}`;

async function request(path: string, options: { method?: string; role?: string; body?: any } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.role) {
    headers['x-actor-role'] = options.role;
    headers['x-actor-id'] = `user-${options.role.toLowerCase()}`;
  }
  const res = await fetch(`${BASE_URL}${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, ok: res.ok, json };
}

async function setupOrderViaApi(docking = false) {
  const create = await request('/api/orders', {
    method: 'POST', role: 'JR_TS',
    body: {
      fleetId: 'ACH-01',
      sumber: 'PMS',
      deskripsi: 'QA audit test defect',
      pekerjaan: docking ? 'QA Docking Periodik' : 'QA Running Repair',
      segmentasi: docking ? 'DOCKING' : 'RUNNING_REPAIR',
      priority: 'MEDIUM',
      targetDays: 10,
      rkaPagu: 400000000
    }
  });
  assert.strictEqual(create.status, 201);
  return create.json;
}

async function runQATests() {
  console.log('==============================================');
  console.log('   QA AUDIT: FLOW BARU + GATE SOP + KEAMANAN  ');
  console.log('==============================================');

  console.log('\n[QA-01] UI & static asset...');
  const indexRes = await fetch(`${BASE_URL}/`);
  assert.strictEqual(indexRes.status, 200);
  console.log('✓ UI tersaji 200 OK');

  console.log('\n[QA-02] Workflow rules endpoint (matriks approval)...');
  const rules = await request('/api/workflow-rules');
  assert.strictEqual(rules.status, 200);
  assert.ok(rules.json.transitions.MRP_STOCK_CHECK.ALLOCATED_WORKSHOP);
  assert.ok(rules.json.transitions.MRP_STOCK_CHECK.REGIONAL_COST_ESTIMATE);
  console.log('✓ Matriks transisi & percabangan MRP tersedia di API');

  console.log('\n[QA-03] Sync dummy Smartsheet...');
  const sync = await request('/api/sync/smartsheet', { method: 'POST' });
  assert.strictEqual(sync.status, 200);
  assert.ok(sync.json.syncedFleets >= 2);
  console.log('✓ Sync fleet + noon report + PMS OK');

  console.log('\n[QA-04] RBAC: role terlarang membuat WO -> 403...');
  const leak = await request('/api/orders', {
    method: 'POST', role: 'KEUANGAN',
    body: { fleetId: 'ACH-01', deskripsi: 'x', pekerjaan: 'y' }
  });
  assert.strictEqual(leak.status, 403);
  console.log('✓ 403 Forbidden - role leak dicegah');

  console.log('\n[QA-05] Validasi field wajib -> 400...');
  const missing = await request('/api/orders', {
    method: 'POST', role: 'JR_TS',
    body: { fleetId: 'ACH-01' }
  });
  assert.strictEqual(missing.status, 400);
  console.log('✓ 400 Bad Request untuk input tidak lengkap');

  console.log('\n[QA-06] Fleet tidak terdaftar -> 400...');
  const badFleet = await request('/api/orders', {
    method: 'POST', role: 'JR_TS',
    body: { fleetId: 'ZZZ-99', deskripsi: 'x', pekerjaan: 'y' }
  });
  assert.strictEqual(badFleet.status, 400);
  assert.match(badFleet.json.error, /tidak terdaftar/);
  console.log('✓ Fleet invalid ditolak');

  console.log('\n[QA-07] Lompatan status ilegal DRAFT -> COMPLETED -> 400...');
  const orderA = await setupOrderViaApi(false);
  const jump = await request(`/api/orders/${orderA.id}/transition`, {
    method: 'POST', role: 'JR_TS',
    body: { toStatus: 'COMPLETED', notes: 'lompat' }
  });
  assert.strictEqual(jump.status, 400);
  assert.match(jump.json.error, /Invalid transition/);
  console.log('✓ Lompatan status diblokir');

  console.log('\n[QA-08] Role salah pada transisi valid -> 400...');
  // JR submit -> SR approve, lalu JR coba lakukan tugas MRP
  await request(`/api/orders/${orderA.id}/transition`, { method: 'POST', role: 'JR_TS', body: { toStatus: 'SUBMITTED_JR_TS', notes: 'submit' } });
  await request(`/api/orders/${orderA.id}/transition`, { method: 'POST', role: 'SR_TS', body: { toStatus: 'APPROVED_SR_TS', notes: 'approve' } });
  const wrongRole = await request(`/api/orders/${orderA.id}/transition`, {
    method: 'POST', role: 'JR_TS',
    body: { toStatus: 'MRP_STOCK_CHECK', notes: 'coba ambil alih tugas MRP' }
  });
  assert.strictEqual(wrongRole.status, 400);
  assert.match(wrongRole.json.error, /Unauthorized/);
  console.log('✓ Transisi oleh role salah ditolak dengan pesan yang jelas');

  console.log('\n[QA-09] Jalur A (stock ada): MRP -> Workshop -> Eksekusi -> Selesai -> BAST -> Payment -> Arsip...');
  await request(`/api/orders/${orderA.id}/transition`, { method: 'POST', role: 'MRP', body: { toStatus: 'MRP_STOCK_CHECK', notes: 'cek stock' } });
  const routeA = await request(`/api/orders/${orderA.id}/transition`, { method: 'POST', role: 'MRP', body: { toStatus: 'ALLOCATED_WORKSHOP', notes: 'stock tersedia di logistik' } });
  assert.strictEqual(routeA.status, 200);
  await request(`/api/orders/${orderA.id}/transition`, { method: 'POST', role: 'WORKSHOP', body: { toStatus: 'EXECUTION', notes: 'mulai dikerjakan' } });
  await request(`/api/orders/${orderA.id}/transition`, { method: 'POST', role: 'WORKSHOP', body: { toStatus: 'WORK_COMPLETED', notes: 'selesai' } });
  const bast = await request(`/api/orders/${orderA.id}/bast`, {
    method: 'POST', role: 'KAPAL',
    body: { perfScoreGalangan: 88, catatan: 'baik', dokumenBastUrl: '/uploads/b.pdf', fotoUrl: '/uploads/f.jpg' }
  });
  assert.strictEqual(bast.status, 201);
  const pay = await request(`/api/orders/${orderA.id}/transition`, { method: 'POST', role: 'KEUANGAN', body: { toStatus: 'PAYMENT_PROCESSED', notes: 'bayar' } });
  assert.strictEqual(pay.status, 200);
  await request(`/api/orders/${orderA.id}/transition`, { method: 'POST', role: 'KEUANGAN', body: { toStatus: 'COMPLETED', notes: 'arsip' } });

  const ordersAfterA = await request('/api/orders');
  const orderAFinal = ordersAfterA.json.find((o: any) => o.id === orderA.id);
  assert.strictEqual(orderAFinal.status, 'COMPLETED');
  assert.strictEqual(orderAFinal.bast.keuanganStatus, 'PAID');
  console.log('✓ Jalur A tuntas: COMPLETED + BAST PAID');

  console.log('\n[QA-10] Gate addendum & BAST...');
  const orderB = await setupOrderViaApi(true);
  // Naikkan sampai EXECUTION
  await request(`/api/orders/${orderB.id}/transition`, { method: 'POST', role: 'JR_TS', body: { toStatus: 'SUBMITTED_JR_TS', notes: 's' } });
  await request(`/api/orders/${orderB.id}/transition`, { method: 'POST', role: 'SR_TS', body: { toStatus: 'APPROVED_SR_TS', notes: 'a' } });

  // BAST sebelum WORK_COMPLETED -> 400
  const earlyBast = await request(`/api/orders/${orderB.id}/bast`, {
    method: 'POST', role: 'JR_TS', body: { perfScoreGalangan: 90 }
  });
  assert.strictEqual(earlyBast.status, 400);
  assert.match(earlyBast.json.error, /WORK_COMPLETED/);

  // Addendum saat belum EXECUTION -> 400
  const ordersB = await request('/api/orders');
  const orderBFull = ordersB.json.find((o: any) => o.id === orderB.id);
  const dockingId = orderBFull.dockingOrder.id;
  const earlyAdd = await request('/api/docking/addendum', {
    method: 'POST', role: 'JR_TS',
    body: { dockingOrderId: dockingId, uraian: 'terlalu awal', estimasiBiaya: 10000000 }
  });
  assert.strictEqual(earlyAdd.status, 400);
  assert.match(earlyAdd.json.error, /EXECUTION/);

  await request(`/api/orders/${orderB.id}/transition`, { method: 'POST', role: 'MRP', body: { toStatus: 'MRP_STOCK_CHECK', notes: 'c' } });
  await request(`/api/orders/${orderB.id}/transition`, { method: 'POST', role: 'MRP', body: { toStatus: 'REGIONAL_COST_ESTIMATE', notes: 'no stock' } });
  await request(`/api/orders/${orderB.id}/transition`, { method: 'POST', role: 'REGIONAL', body: { toStatus: 'REGIONAL_PR_PBJ', notes: 'PR' } });
  await request(`/api/orders/${orderB.id}/transition`, { method: 'POST', role: 'REGIONAL', body: { toStatus: 'EXECUTION', notes: 'mulai' } });

  // Addendum negatif -> 400
  const negAdd = await request('/api/docking/addendum', {
    method: 'POST', role: 'JR_TS',
    body: { dockingOrderId: dockingId, uraian: 'nilai negatif', estimasiBiaya: -500 }
  });
  assert.strictEqual(negAdd.status, 400);

  // Addendum kecil 5% -> SR approve OK
  const smallAdd = await request('/api/docking/addendum', {
    method: 'POST', role: 'JR_TS',
    body: { dockingOrderId: dockingId, uraian: 'addendum kecil 5%', estimasiBiaya: 20000000 }
  });
  assert.strictEqual(smallAdd.status, 201);
  assert.strictEqual(smallAdd.json.needsDirtek, false);
  const srApprove = await request(`/api/docking/addendum/${smallAdd.json.id}/approve`, { method: 'POST', role: 'SR_TS', body: {} });
  assert.strictEqual(srApprove.status, 200);
  await request(`/api/orders/${orderB.id}/transition`, { method: 'POST', role: 'JR_TS', body: { toStatus: 'EXECUTION', notes: 'lanjut' } });

  // Addendum besar 15% -> SR ditolak, OMA OK
  const bigAdd = await request('/api/docking/addendum', {
    method: 'POST', role: 'JR_TS',
    body: { dockingOrderId: dockingId, uraian: 'addendum besar 15%', estimasiBiaya: 60000000 }
  });
  assert.strictEqual(bigAdd.json.needsDirtek, true);
  const srBlocked = await request(`/api/docking/addendum/${bigAdd.json.id}/approve`, { method: 'POST', role: 'SR_TS', body: {} });
  assert.strictEqual(srBlocked.status, 400);
  assert.match(srBlocked.json.error, /Direktur Teknik/);
  const omaApprove = await request(`/api/docking/addendum/${bigAdd.json.id}/approve`, { method: 'POST', role: 'OMA_ADMIN', body: {} });
  assert.strictEqual(omaApprove.status, 200);
  console.log('✓ Semua gate addendum & BAST sesuai SOP');

  console.log('\n[QA-11] Transisi target khusus lewat endpoint generik -> 400...');
  await request(`/api/orders/${orderB.id}/transition`, { method: 'POST', role: 'JR_TS', body: { toStatus: 'EXECUTION', notes: 'lanjut' } });
  const bypass = await request(`/api/orders/${orderB.id}/transition`, {
    method: 'POST', role: 'JR_TS',
    body: { toStatus: 'BAST_SUBMITTED', notes: 'bypass' }
  });
  assert.strictEqual(bypass.status, 400);
  assert.match(bypass.json.error, /endpoint khusus/);
  console.log('✓ Bypass gate via endpoint generik diblokir');

  console.log('\n[QA-12] Milestone BA hanya saat eksekusi docking...');
  const ms = await request('/api/docking/milestone', {
    method: 'POST', role: 'JR_TS',
    body: { dockingOrderId: dockingId, tipeBa: 'NAIK_DOK', dokumenBaUrl: '/uploads/naik.pdf' }
  });
  assert.strictEqual(ms.status, 201);
  const msWrongRole = await request('/api/docking/milestone', {
    method: 'POST', role: 'KEUANGAN',
    body: { dockingOrderId: dockingId, tipeBa: 'TURUN_DOK', dokumenBaUrl: '/uploads/turun.pdf' }
  });
  assert.strictEqual(msWrongRole.status, 400);
  console.log('✓ Milestone BA tercatat & role salah ditolak');

  console.log('\n[QA-13] Duplikasi BAST -> 400...');
  await request(`/api/orders/${orderB.id}/transition`, { method: 'POST', role: 'JR_TS', body: { toStatus: 'WORK_COMPLETED', notes: 'selesai' } });
  const bast1 = await request(`/api/orders/${orderB.id}/bast`, { method: 'POST', role: 'KAPAL', body: { perfScoreGalangan: 91 } });
  assert.strictEqual(bast1.status, 201);
  const bast2 = await request(`/api/orders/${orderB.id}/bast`, { method: 'POST', role: 'KAPAL', body: { perfScoreGalangan: 91 } });
  assert.strictEqual(bast2.status, 400);
  assert.match(bast2.json.error, /sudah pernah disahkan/);
  console.log('✓ Duplikasi BAST ditolak dengan pesan bisnis jelas');

  console.log('\n==============================================');
  console.log('   QA AUDIT SELESAI - SEMUA PERTAHANAN LOLOS  ');
  console.log('==============================================');
}

runQATests()
  .catch((e) => { console.error('QA audit gagal:', e); process.exit(1); })
  .finally(async () => { server.close(); await prisma.$disconnect(); });
