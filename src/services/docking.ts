import { PrismaClient, Role, OrderStatus } from '@prisma/client';
import { WorkflowService, ADMIN_ROLES } from './workflow.js';

export interface CreateAddendumInput {
  dockingOrderId: string;
  uraian: string;
  estimasiBiaya: number;
  actorId: string;
  actorRole: Role;
}

export interface DecideAddendumInput {
  addendumId: string;
  actorId: string;
  actorRole: Role;
  catatan?: string;
}

export interface RecordMilestoneInput {
  dockingOrderId: string;
  tipeBa: 'JOINT_SURVEY' | 'NAIK_DOK' | 'TURUN_DOK' | 'SEA_TRIAL';
  dokumenBaUrl: string;
  tanggal?: Date;
  actorId: string;
  actorRole: Role;
}

export interface SubmitBastInput {
  workOrderId: string;
  dokumenBastUrl: string;
  fotoUrl: string;
  perfScoreGalangan: number;
  catatan?: string;
  actorId: string;
  actorRole: Role;
}

export class DockingService {
  constructor(
    private prisma: PrismaClient,
    private workflow: WorkflowService
  ) {}

  // SOP Docking: pengajuan Pekerjaan Tambahan hanya saat masa eksekusi docking
  async requestAddendum(input: CreateAddendumInput) {
    if (input.estimasiBiaya <= 0) {
      throw new Error('Estimasi biaya addendum harus lebih besar dari 0');
    }

    const dockingOrder = await this.prisma.dockingOrder.findUnique({
      where: { id: input.dockingOrderId },
      include: { workOrder: true }
    });

    if (!dockingOrder) {
      throw new Error(`Docking order ${input.dockingOrderId} not found`);
    }

    if (dockingOrder.workOrder.status !== OrderStatus.EXECUTION) {
      throw new Error('Addendum hanya dapat diajukan saat pekerjaan berstatus EXECUTION');
    }

    const persentase = dockingOrder.rkaPagu > 0
      ? (input.estimasiBiaya / dockingOrder.rkaPagu) * 100
      : 0;

    // Rule SOP: > 10% pagu RKA butuh persetujuan level Direktur Teknik / OMA
    const needsDirtek = persentase > 10;

    const addendum = await this.prisma.dockingAddendum.create({
      data: {
        dockingOrderId: input.dockingOrderId,
        uraian: input.uraian,
        estimasiBiaya: input.estimasiBiaya,
        persentasePagu: persentase,
        needsDirtek,
        approved: false
      }
    });

    await this.workflow.transitionOrder({
      workOrderId: dockingOrder.workOrderId,
      actorId: input.actorId,
      actorRole: input.actorRole,
      toStatus: OrderStatus.ADDENDUM_REQUESTED,
      notes: `Addendum diajukan: ${input.uraian} (${persentase.toFixed(1)}% RKA). Butuh Dirtek: ${needsDirtek}`
    });

    return addendum;
  }

  async approveAddendum(input: DecideAddendumInput) {
    const addendum = await this.prisma.dockingAddendum.findUnique({
      where: { id: input.addendumId },
      include: { dockingOrder: { include: { workOrder: true } } }
    });

    if (!addendum) {
      throw new Error(`Addendum ${input.addendumId} not found`);
    }
    if (addendum.approved || addendum.rejected) {
      throw new Error('Addendum ini sudah diputuskan sebelumnya');
    }
    if (addendum.dockingOrder.workOrder.status !== OrderStatus.ADDENDUM_REQUESTED) {
      throw new Error('Order tidak dalam status menunggu keputusan addendum');
    }

    // Gate SOP: > 10% pagu RKA wajib otorisasi Direktur Teknik (OMA)
    if (addendum.needsDirtek && !ADMIN_ROLES.includes(input.actorRole)) {
      throw new Error('Addendum melebihi 10% pagu RKA, wajib otorisasi OMA / Direktur Teknik');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.dockingAddendum.update({
        where: { id: input.addendumId },
        data: { approved: true, approvedBy: input.actorId }
      });

      await tx.dockingOrder.update({
        where: { id: addendum.dockingOrderId },
        data: { totalAddendum: { increment: addendum.estimasiBiaya } }
      });
    });

    return this.workflow.transitionOrder({
      workOrderId: addendum.dockingOrder.workOrderId,
      actorId: input.actorId,
      actorRole: input.actorRole,
      toStatus: OrderStatus.ADDENDUM_APPROVED,
      notes: input.catatan || `Addendum disetujui (${addendum.persentasePagu.toFixed(1)}% RKA)`
    });
  }

  async rejectAddendum(input: DecideAddendumInput) {
    const addendum = await this.prisma.dockingAddendum.findUnique({
      where: { id: input.addendumId },
      include: { dockingOrder: { include: { workOrder: true } } }
    });

    if (!addendum) {
      throw new Error(`Addendum ${input.addendumId} not found`);
    }
    if (addendum.approved || addendum.rejected) {
      throw new Error('Addendum ini sudah diputuskan sebelumnya');
    }
    if (addendum.dockingOrder.workOrder.status !== OrderStatus.ADDENDUM_REQUESTED) {
      throw new Error('Order tidak dalam status menunggu keputusan addendum');
    }
    if (!ADMIN_ROLES.includes(input.actorRole) && ![Role.SR_TS, Role.REGIONAL].includes(input.actorRole)) {
      throw new Error(`Role ${input.actorRole} tidak berhak menolak addendum`);
    }

    await this.prisma.dockingAddendum.update({
      where: { id: input.addendumId },
      data: { rejected: true }
    });

    return this.workflow.transitionOrder({
      workOrderId: addendum.dockingOrder.workOrderId,
      actorId: input.actorId,
      actorRole: input.actorRole,
      toStatus: OrderStatus.EXECUTION,
      notes: input.catatan || `Addendum ditolak: ${addendum.uraian}`
    });
  }

  async recordMilestone(input: RecordMilestoneInput) {
    const dockingOrder = await this.prisma.dockingOrder.findUnique({
      where: { id: input.dockingOrderId },
      include: { workOrder: true }
    });

    if (!dockingOrder) {
      throw new Error(`Docking order ${input.dockingOrderId} not found`);
    }

    const allowedStatuses: OrderStatus[] = [
      OrderStatus.EXECUTION,
      OrderStatus.ADDENDUM_REQUESTED,
      OrderStatus.ADDENDUM_APPROVED
    ];
    if (!allowedStatuses.includes(dockingOrder.workOrder.status)) {
      throw new Error('Milestone Berita Acara hanya dapat dicatat selama masa pelaksanaan docking');
    }
    if (!ADMIN_ROLES.includes(input.actorRole) && ![Role.JR_TS, Role.SR_TS].includes(input.actorRole)) {
      throw new Error(`Role ${input.actorRole} tidak berhak mencatat milestone BA docking`);
    }

    return this.prisma.dockingMilestone.create({
      data: {
        dockingOrderId: input.dockingOrderId,
        tipeBa: input.tipeBa,
        tanggal: input.tanggal ?? new Date(),
        dokumenBaUrl: input.dokumenBaUrl,
        isVerified: true
      }
    });
  }

  // BAST + Performance Scoring + Dokumen Foto (Jr TS / Kapal), generik semua segmentasi
  async submitBast(input: SubmitBastInput) {
    const workOrder = await this.prisma.workOrder.findUnique({
      where: { id: input.workOrderId }
    });

    if (!workOrder) {
      throw new Error(`Work order ${input.workOrderId} not found`);
    }
    if (input.perfScoreGalangan < 0 || input.perfScoreGalangan > 100) {
      throw new Error('Skor kinerja harus di antara 0 - 100');
    }

    const existingBast = await this.prisma.bASTRecord.findUnique({
      where: { workOrderId: input.workOrderId }
    });
    if (existingBast) {
      throw new Error('BAST untuk pekerjaan ini sudah pernah disahkan');
    }

    if (workOrder.status !== OrderStatus.WORK_COMPLETED) {
      throw new Error('BAST hanya dapat diunggah setelah pekerjaan dinyatakan selesai (WORK_COMPLETED)');
    }

    const bast = await this.prisma.bASTRecord.create({
      data: {
        workOrderId: input.workOrderId,
        dokumenBastUrl: input.dokumenBastUrl,
        fotoUrl: input.fotoUrl,
        perfScoreGalangan: input.perfScoreGalangan,
        catatan: input.catatan,
        keuanganStatus: 'PENDING_PAYMENT'
      }
    });

    await this.workflow.transitionOrder({
      workOrderId: input.workOrderId,
      actorId: input.actorId,
      actorRole: input.actorRole,
      toStatus: OrderStatus.BAST_SUBMITTED,
      notes: `BAST + dokumen foto diunggah. Skor kinerja: ${input.perfScoreGalangan}`
    });

    return bast;
  }
}
