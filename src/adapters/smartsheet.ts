// ponytail: Mock adapter replacing live Smartsheet REST API, upgrade with actual fetch(https://api.smartsheet.com/2.0) and Bearer token
export interface SmartsheetRow {
  id: string;
  cells: Record<string, any>;
}

export interface SmartsheetSheet {
  id: string;
  name: string;
  columns: string[];
  rows: SmartsheetRow[];
}

export class DummySmartsheetAdapter {
  private mockSheets: Map<string, SmartsheetSheet> = new Map();

  constructor() {
    this.seedMockData();
  }

  private seedMockData() {
    this.mockSheets.set('fleet_master', {
      id: 'sheet_001',
      name: 'Fleet ID',
      columns: ['Fleet ID', 'Fleet Name', 'Shipowner', 'Type of Vessel', 'IMO No'],
      rows: [
        {
          id: 'row_1',
          cells: {
            'Fleet ID': 'ACH-01',
            'Fleet Name': 'ACEH HEBAT 1',
            'Shipowner': 'Dishub Aceh',
            'Type of Vessel': 'Ro-Ro Passenger',
            'IMO No': '9912345'
          }
        },
        {
          id: 'row_2',
          cells: {
            'Fleet ID': 'KRP-02',
            'Fleet Name': 'KMP Kerapu',
            'Shipowner': 'PT ASDP Indonesia Ferry',
            'Type of Vessel': 'Ferry',
            'IMO No': '9876543'
          }
        }
      ]
    });

    this.mockSheets.set('noon_report', {
      id: 'sheet_002',
      name: 'Noon Report',
      columns: ['Fleet ID', 'Report Date', 'RH Mesin', 'Keterangan'],
      rows: [
        {
          id: 'row_nr_1',
          cells: {
            'Fleet ID': 'ACH-01',
            'Report Date': new Date().toISOString(),
            'RH Mesin': 1420.5,
            'Keterangan': 'Kondisi pelayaran normal cuaca cerah'
          }
        }
      ]
    });

    this.mockSheets.set('pms', {
      id: 'sheet_003',
      name: 'PMS',
      columns: ['ID PMS', 'Fleet ID', 'Pekerjaan', 'Interval', 'Interval RH', 'RH Sekarang', 'Tanggal Jatuh Tempo', 'Status'],
      rows: [
        {
          id: 'pms_row_1',
          cells: {
            'ID PMS': 'PMS-ACH-001',
            'Fleet ID': 'ACH-01',
            'Pekerjaan': 'Overhaul pompa pendingin utama mesin induk',
            'Interval': 'Running Hour Based',
            'Interval RH': 2000,
            'RH Sekarang': 1420,
            'Tanggal Jatuh Tempo': new Date(Date.now() + 30 * 86400000).toISOString(),
            'Status': 'PENDING'
          }
        },
        {
          id: 'pms_row_2',
          cells: {
            'ID PMS': 'PMS-KRP-001',
            'Fleet ID': 'KRP-02',
            'Pekerjaan': 'Inspeksi sistem kemudi dan hidrolik',
            'Interval': 'Monthly',
            'Interval RH': null,
            'RH Sekarang': 860,
            'Tanggal Jatuh Tempo': new Date(Date.now() + 10 * 86400000).toISOString(),
            'Status': 'PENDING'
          }
        }
      ]
    });
  }

  async getSheet(sheetKey: string): Promise<SmartsheetSheet> {
    const sheet = this.mockSheets.get(sheetKey);
    if (!sheet) {
      throw new Error(`Sheet ${sheetKey} not found in mock store`);
    }
    return sheet;
  }

  async fetchNoonReportStream(): Promise<SmartsheetRow[]> {
    const sheet = await this.getSheet('noon_report');
    return sheet.rows;
  }
}
