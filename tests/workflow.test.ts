import assert from 'node:assert';
import { PrismaClient, Role, OrderStatus, WorkSegmentation, PriorityLevel } from '@prisma/client';
import { DummySmartsheetAdapter } from '../src/adapters/smartsheet.js';
import { SyncService } from '../src/services/sync.js';
import { WorkflowService } from '../src/services/workflow.js';
import { DockingService } from '../src/services/docking.js';

const prisma = new PrismaClient();
const adapter = new DummySmartsheetAdapter();
const syncService = new SyncService(prisma, adapter);
const workflowService = new WorkflowService(prisma);
const dockingService = new DockingService(prisma, workflowService);

async function runTests() {
  console.log('=== E2E WORKFLOW TEST: ALUR ERD LENGKAP (DOCKING + ADDENDUM + BAST) ===');

  console.log('[1] Sync master data (dummy Smartsheet)...');
  const fleetCount = await syncService.syncFleetMaster();
  assert.ok(fleetCount >= 2);
  await syncService.syncNoonReport();
  await syncService.syncPms();
  console.log('✓ Sync OK');

  console.log('[2] Setup users...');
  const users: Record<string, string> = {};
  for (const [key, role] of [
    ['jr', Role.JR_TS], ['sr', Role.SR_TS], ['mrp', Role.MRP], ['oma', Role.OMA_ADMIN],
    ['kapal', Role.KAPAL], ['keuangan', Role.KEUANGAN], ['workshop', Role.WORKSHOP], ['regional', Role.REGIONAL]
  ] as [string, Role][]) {
    const u = await prisma.user.upsert({
      where: { email: `${key}@armada.com` },
      update: {},
      create: { email: `${key}@armada.com`, name: key.toUpperCase(), role }
    });
    users[key] = u.id;
  }

  console.log('[3] Kapal input temuan -> Defect List -> Work Order Docking...');
  const defect = await prisma.defectList.create({
    data: {
      fleetId: 'ACH-01',
      sumber: 'PMS',
      priority: PriorityLevel.HIGH,
      deskripsi: 'Kebocoran stern tube seal saat pelayaran',
      dueDate: new Date(Date.now() + 7 * 86400000),
      segmentasi: WorkSegmentation.DOCKING
    }
  });
  const wo = await prisma.workOrder.create({
    data: {
      fleetId: 'ACH-01',
      defectId: defect.id,
      segmentasi: WorkSegmentation.DOCKING,
      pekerjaan: 'Perbaikan Stern Tube & Penggantian Seal',
      status: OrderStatus.DRAFT
    }
  });
  const dockingOrder = await prisma.dockingOrder.create({
    data: { fleetId: 'ACH-01', workOrderId: wo.id, targetDays: 14, rkaPagu: 500000000 }
  });

  console.log('[4] Jr TS submit -> Sr TS approve -> MRP cek stock -> Regional (pengadaan)...');
  await workflowService.transitionOrder({ workOrderId: wo.id, actorId: users.jr, actorRole: Role.JR_TS, toStatus: OrderStatus.SUBMITTED_JR_TS, notes: 'Diajukan untuk review' });
  await workflowService.transitionOrder({ workOrderId: wo.id, actorId: users.sr, actorRole: Role.SR_TS, toStatus: OrderStatus.APPROVED_SR_TS, notes: 'Scope terverifikasi' });
  await workflowService.transitionOrder({ workOrderId: wo.id, actorId: users.mrp, actorRole: Role.MRP, toStatus: OrderStatus.MRP_STOCK_CHECK, notes: 'Mulai verifikasi stock' });
  await workflowService.transitionOrder({ workOrderId: wo.id, actorId: users.mrp, actorRole: Role.MRP, toStatus: OrderStatus.REGIONAL_COST_ESTIMATE, notes: 'Stock tidak tersedia, eskalasi pengadaan' });
  await workflowService.transitionOrder({ workOrderId: wo.id, actorId: users.regional, actorRole: Role.REGIONAL, toStatus: OrderStatus.REGIONAL_PR_PBJ, notes: 'PR dibuat, penawaran PBJ diproses' });
  await workflowService.transitionOrder({ workOrderId: wo.id, actorId: users.regional, actorRole: Role.REGIONAL, toStatus: OrderStatus.EXECUTION, notes: 'Galangan ditunjuk, docking dimulai' });
  console.log('✓ Order mencapai EXECUTION via jalur pengadaan regional');

  console.log('[5] Catat milestone BA SOP selama eksekusi...');
  for (const tipeBa of ['JOINT_SURVEY', 'NAIK_DOK', 'TURUN_DOK', 'SEA_TRIAL'] as const) {
    await dockingService.recordMilestone({
      dockingOrderId: dockingOrder.id,
      tipeBa,
      dokumenBaUrl: `/uploads/ba_${tipeBa.toLowerCase()}.pdf`,
      actorId: users.jr,
      actorRole: Role.JR_TS
    });
  }
  const milestones = await prisma.dockingMilestone.count({ where: { dockingOrderId: dockingOrder.id } });
  assert.strictEqual(milestones, 4);
  console.log('✓ 4 milestone BA tercatat');

  console.log('[6] Addendum kecil (8% RKA) -> approval Sr TS...');
  const smallAdd = await dockingService.requestAddendum({
    dockingOrderId: dockingOrder.id,
    uraian: 'Pembersihan sea chest tambahan',
    estimasiBiaya: 40000000,
    actorId: users.jr,
    actorRole: Role.JR_TS
  });
  assert.strictEqual(smallAdd.needsDirtek, false);
  await dockingService.approveAddendum({ addendumId: smallAdd.id, actorId: users.sr, actorRole: Role.SR_TS });
  let current = await prisma.workOrder.findUnique({ where: { id: wo.id } });
  assert.strictEqual(current?.status, OrderStatus.ADDENDUM_APPROVED);
  await workflowService.transitionOrder({ workOrderId: wo.id, actorId: users.jr, actorRole: Role.JR_TS, toStatus: OrderStatus.EXECUTION, notes: 'Lanjutkan docking' });
  console.log('✓ Addendum ≤10% disetujui Sr TS');

  console.log('[7] Addendum besar (20% RKA) -> SR ditolak, OMA approve...');
  const bigAdd = await dockingService.requestAddendum({
    dockingOrderId: dockingOrder.id,
    uraian: 'Penggantian pelat lambung lajur B (korosi berat)',
    estimasiBiaya: 100000000,
    actorId: users.jr,
    actorRole: Role.JR_TS
  });
  assert.strictEqual(bigAdd.needsDirtek, true);

  let srBlocked = false;
  try {
    await dockingService.approveAddendum({ addendumId: bigAdd.id, actorId: users.sr, actorRole: Role.SR_TS });
  } catch (err: any) {
    srBlocked = true;
    assert.match(err.message, /Direktur Teknik/);
  }
  assert.ok(srBlocked, 'SR TS harus diblokir untuk addendum >10%');

  await dockingService.approveAddendum({ addendumId: bigAdd.id, actorId: users.oma, actorRole: Role.OMA_ADMIN });
  await workflowService.transitionOrder({ workOrderId: wo.id, actorId: users.jr, actorRole: Role.JR_TS, toStatus: OrderStatus.EXECUTION, notes: 'Lanjutkan setelah addendum disetujui' });

  const doUpdated = await prisma.dockingOrder.findUnique({ where: { id: dockingOrder.id } });
  assert.strictEqual(doUpdated?.totalAddendum, 140000000);
  console.log('✓ Gate SOP addendum >10% dipatuhi (total addendum Rp 140jt)');

  console.log('[8] Eksekusi selesai -> BAST + Scoring (Kapal/Jr TS)...');
  await workflowService.transitionOrder({ workOrderId: wo.id, actorId: users.jr, actorRole: Role.JR_TS, toStatus: OrderStatus.WORK_COMPLETED, notes: 'Pekerjaan docking rampung' });

  const bast = await dockingService.submitBast({
    workOrderId: wo.id,
    dokumenBastUrl: '/uploads/bast_ach01.pdf',
    fotoUrl: '/uploads/foto_ach01.jpg',
    perfScoreGalangan: 92.5,
    catatan: 'Selesai tepat waktu, lulus sea trial',
    actorId: users.kapal,
    actorRole: Role.KAPAL
  });
  assert.ok(bast.id);
  console.log('✓ BAST + skor + foto terunggah');

  console.log('[9] Keuangan proses payment -> arsip OMA...');
  await workflowService.transitionOrder({ workOrderId: wo.id, actorId: users.keuangan, actorRole: Role.KEUANGAN, toStatus: OrderStatus.PAYMENT_PROCESSED, notes: 'Invoice & BAST diverifikasi' });
  const bastPaid = await prisma.bASTRecord.findUnique({ where: { workOrderId: wo.id } });
  assert.strictEqual(bastPaid?.keuanganStatus, 'PAID');
  await workflowService.transitionOrder({ workOrderId: wo.id, actorId: users.keuangan, actorRole: Role.KEUANGAN, toStatus: OrderStatus.COMPLETED, notes: 'Order selesai & diarsipkan' });

  const final = await prisma.workOrder.findUnique({ where: { id: wo.id } });
  assert.strictEqual(final?.status, OrderStatus.COMPLETED);
  console.log('✓ Order COMPLETED dan BAST berstatus PAID');

  console.log('[10] Negative test: role tidak berhak diblokir...');
  const wo2 = await prisma.workOrder.create({
    data: { fleetId: 'KRP-02', segmentasi: WorkSegmentation.RUNNING_REPAIR, pekerjaan: 'Running repair uji RBAC', status: OrderStatus.DRAFT }
  });
  let blocked = false;
  try {
    await workflowService.transitionOrder({ workOrderId: wo2.id, actorId: users.keuangan, actorRole: Role.KEUANGAN, toStatus: OrderStatus.SUBMITTED_JR_TS });
  } catch (err: any) {
    blocked = true;
    assert.match(err.message, /Unauthorized/);
  }
  assert.ok(blocked, 'KEUANGAN tidak boleh submit WO');
  console.log('✓ RBAC menolak role yang tidak berhak');

  console.log('[11] Tracking audit trail...');
  const history = await workflowService.getOrderTrackingHistory(wo.id);
  assert.ok(history.length >= 14, `Tracking minimal 14 baris, aktual ${history.length}`);
  for (const t of history) {
    console.log(`  [${new Date(t.timestamp).toISOString()}] ${t.fromStatus} -> ${t.toStatus} (${t.actorRole}) "${t.notes}"`);
  }
  console.log('✓ Audit trail lengkap');

  console.log('\n>>> SEMUA TEST WORKFLOW LULUS <<<');
}

runTests()
  .catch((e) => { console.error('Test gagal:', e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
