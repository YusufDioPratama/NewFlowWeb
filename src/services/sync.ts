import { PrismaClient } from '@prisma/client';
import { DummySmartsheetAdapter } from '../adapters/smartsheet.js';

// ponytail: Basic upsert sync loop, upgrade with batch transactions and Smartsheet webhook trigger
export class SyncService {
  constructor(
    private prisma: PrismaClient,
    private adapter: DummySmartsheetAdapter
  ) {}

  async syncFleetMaster(): Promise<number> {
    const sheet = await this.adapter.getSheet('fleet_master');
    let count = 0;

    for (const row of sheet.rows) {
      const fleetId = row.cells['Fleet ID'];
      const name = row.cells['Fleet Name'];
      const shipowner = row.cells['Shipowner'];
      const vesselType = row.cells['Type of Vessel'];
      const imoNo = row.cells['IMO No'];

      await this.prisma.fleet.upsert({
        where: { id: fleetId },
        update: { name, shipowner, vesselType, imoNo },
        create: { id: fleetId, name, shipowner, vesselType, imoNo }
      });
      count++;
    }

    return count;
  }

  async syncNoonReport(): Promise<number> {
    const rows = await this.adapter.fetchNoonReportStream();
    let count = 0;

    for (const row of rows) {
      const fleetId = row.cells['Fleet ID'];
      const reportDate = new Date(row.cells['Report Date']);
      const rhMesin = parseFloat(row.cells['RH Mesin']) || 0;
      const keterangan = row.cells['Keterangan'];

      await this.prisma.noonReport.create({
        data: { fleetId, reportDate, rhMesin, keterangan }
      });
      count++;
    }

    return count;
  }

  async syncPms(): Promise<number> {
    const sheet = await this.adapter.getSheet('pms');
    let count = 0;

    for (const row of sheet.rows) {
      const id = row.cells['ID PMS'];
      await this.prisma.pMS.upsert({
        where: { id },
        update: {
          rhCurrent: parseFloat(row.cells['RH Sekarang']) || 0,
          status: row.cells['Status']
        },
        create: {
          id,
          fleetId: row.cells['Fleet ID'],
          pekerjaan: row.cells['Pekerjaan'],
          intervalType: row.cells['Interval'],
          intervalRh: parseFloat(row.cells['Interval RH']) || null,
          rhCurrent: parseFloat(row.cells['RH Sekarang']) || 0,
          tanggalJatuhTempo: new Date(row.cells['Tanggal Jatuh Tempo']),
          status: row.cells['Status'] || 'PENDING'
        }
      });
      count++;
    }

    return count;
  }
}
