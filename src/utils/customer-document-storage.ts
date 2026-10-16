import {mkdirSync} from 'fs';
import path from 'path';

/** Storage folders for server-generated customer documents. */
export const CUSTOMER_DOCUMENT_FOLDERS = [
  'order-summaries',
  'payment-receipts',
  'invoices',
] as const;

export function prepareCustomerDocumentFolders(root: string): void {
  for (const folder of CUSTOMER_DOCUMENT_FOLDERS) {
    mkdirSync(path.join(root, folder), {recursive: true});
  }
}

