const fs = require('fs');

const dumpFile = '../data-backup/dump.sql';
const outputFile = './src/data/seed-masters.json';

const tablesToExtract = [
  'media', 'brand', 'color', 'stain', 'damage_type', 'item_category', 'service',
  'customer_label', 'order_label', 'customer_discount_group', 'process_step',
  'service_category', 'item', 'region', 'cluster', 'store', 'price_list',
  'price_list_item', 'cluster_price_list', 'store_price_override',
  'store_service_mapping', 'service_item_mapping', 'service_process_mapping',
  'additional_charge_master', 'customer_type_master', 'gst_tax_configuration',
  'delivery_type_configuration', 'wallet_configuration', 'bag'
];

const content = fs.readFileSync(dumpFile, 'utf8');
const lines = content.split('\n');

const result = {};
let currentTable = null;
let currentColumns = [];

for (const line of lines) {
  if (line.startsWith('COPY public.')) {
    const match = line.match(/^COPY public\.(\w+) \((.*?)\) FROM stdin;/);
    if (match) {
      const tableName = match[1];
      if (tablesToExtract.includes(tableName)) {
        currentTable = tableName;
        currentColumns = match[2].split(',').map(c => c.trim().toLowerCase());
        result[currentTable] = [];
        continue;
      }
    }
  }

  if (currentTable) {
    if (line === '\\.') {
      currentTable = null;
      continue;
    }

    const values = line.split('\t');
    if (values.length === currentColumns.length) {
      const record = {};
      for (let i = 0; i < currentColumns.length; i++) {
        let val = values[i];
        if (val === '\\N') {
          val = null;
        } else if (val === 't') {
          val = true;
        } else if (val === 'f') {
          val = false;
        }
        
        // Let's keep strings for now, if they look like JSON, maybe parse them? Or just keep strings.
        // Some might be numeric.
        if (typeof val === 'string' && val !== null) {
            if (/^\d+$/.test(val)) {
                val = parseInt(val, 10);
            } else if (/^\d+\.\d+$/.test(val)) {
                val = parseFloat(val);
            }
        }

        record[currentColumns[i]] = val;
      }
      result[currentTable].push(record);
    }
  }
}

if (!fs.existsSync('./src/data')) {
    fs.mkdirSync('./src/data');
}
fs.writeFileSync(outputFile, JSON.stringify(result, null, 2));
console.log(`Extracted master data to ${outputFile}`);
