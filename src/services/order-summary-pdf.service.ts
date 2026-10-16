import {Getter, inject} from '@loopback/core';
import {repository} from '@loopback/repository';
import {HttpErrors} from '@loopback/rest';
import {createHmac, randomUUID, timingSafeEqual} from 'crypto';
import {promises as fs} from 'fs';
import path from 'path';
import PDFDocument from 'pdfkit';
import {STORAGE_DIRECTORY} from '../keys';
import {Customer, CustomerAddress, Order, Store} from '../models';
import type {
  BrandRepository,
  ColorRepository,
  CustomerAddressRepository,
  CustomerPhoneRepository,
  CustomerRepository,
  StoreRepository,
  WalletRepository,
} from '../repositories';
import type {OrderService} from './order.service';

interface ReceiptExtra {
  name?: string | null;
  amount?: number;
  quantity?: number;
}
interface ReceiptGarment {
  brandId?: string;
  colorId?: string;
  brandName?: string;
  colorName?: string;
  inspectionRemarks?: string;
  status?: string;
  length?: number;
  width?: number;
  customerRemarks?: string;
  additionalServices?: ReceiptExtra[];
  additionalCharges?: ReceiptExtra[];
}
interface SummaryDetails {
  order: Order & {
    customer?: {fullName?: string; phone?: string} | null;
    receivedByName?: string;
  };
  items: {
    itemName?: string;
    serviceName?: string;
    quantity: number;
    totalPrice: number;
    unitPrice?: number;
    isMeasurement?: boolean;
    rejectedAtIntake?: boolean;
    additionalServices?: ReceiptExtra[];
    additionalCharges?: ReceiptExtra[];
    garments?: ReceiptGarment[];
  }[];
  orderCharges?: ReceiptExtra[];
  paymentTransactions?: {
    paymentMode: string;
    transactionType?: string;
    transactionReference?: string;
  }[];
  totalCollected: number;
  balanceDue: number;
}

/** Generates only order-created summaries; no Media or order relation writes. */
export class OrderSummaryPdfService {
  constructor(
    @inject(STORAGE_DIRECTORY) private storageDirectory: string,
    // Deferred to avoid OrderService -> WhatsAppService -> PDF -> OrderService.
    @inject.getter('services.order') private getOrders: Getter<OrderService>,
    @repository.getter('StoreRepository')
    private getStores: Getter<StoreRepository>,
    @repository.getter('CustomerRepository')
    private getCustomers: Getter<CustomerRepository>,
    @repository.getter('CustomerAddressRepository')
    private getAddresses: Getter<CustomerAddressRepository>,
    @repository.getter('CustomerPhoneRepository')
    private getPhones: Getter<CustomerPhoneRepository>,
    @repository.getter('WalletRepository')
    private getWallets: Getter<WalletRepository>,
    @repository.getter('BrandRepository')
    private getBrands: Getter<BrandRepository>,
    @repository.getter('ColorRepository')
    private getColors: Getter<ColorRepository>,
  ) {}

  private secret(): string {
    const secret = process.env.ORDER_SUMMARY_URL_SIGNING_SECRET?.trim();
    if (!secret || Buffer.byteLength(secret) < 32) {
      throw new Error(
        'ORDER_SUMMARY_URL_SIGNING_SECRET must contain at least 32 bytes.',
      );
    }
    return secret;
  }

  private signature(fileName: string, expires: string): Buffer {
    return createHmac('sha256', this.secret())
      .update(`order-summary\n${fileName}\n${expires}`)
      .digest();
  }

  private baseUrl(): URL {
    const configuredBase = process.env.PUBLIC_DOCUMENT_BASE_URL?.trim();
    const base = new URL(
      configuredBase ? configuredBase : (process.env.API_ENDPOINT ?? ''),
    );
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
    const developmentLocal = local && process.env.NODE_ENV !== 'production';
    if (
      (base.protocol !== 'https:' &&
        !(developmentLocal && base.protocol === 'http:')) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      (local && !developmentLocal)
    ) {
      throw new Error(
        'PUBLIC_DOCUMENT_BASE_URL must be a public HTTPS backend URL.',
      );
    }
    return base;
  }

  async createForOrder(orderId: string): Promise<string> {
    // Validate configuration before creating files or querying receipt data.
    const base = this.baseUrl();
    this.secret();
    const configuredTtl = Number(
      process.env.ORDER_SUMMARY_LINK_TTL_SECONDS ?? 604800,
    );
    if (
      !Number.isSafeInteger(configuredTtl) ||
      configuredTtl < 60 ||
      configuredTtl > 31536000
    ) {
      throw new Error(
        'ORDER_SUMMARY_LINK_TTL_SECONDS must be between 60 and 31536000.',
      );
    }
    const details = (await (
      await this.getOrders()
    ).getOrderDetails(orderId)) as SummaryDetails;
    const store = await (
      await this.getStores()
    ).findById(details.order.storeId);
    const customerId = details.order.customerId;
    const garments = details.items.flatMap(item => item.garments ?? []);
    const brandIds = [
      ...new Set(garments.flatMap(g => (g.brandId ? [g.brandId] : []))),
    ];
    const colorIds = [
      ...new Set(garments.flatMap(g => (g.colorId ? [g.colorId] : []))),
    ];
    const [brands, colors] = await Promise.all([
      brandIds.length
        ? (await this.getBrands()).find({where: {id: {inq: brandIds}}})
        : [],
      colorIds.length
        ? (await this.getColors()).find({where: {id: {inq: colorIds}}})
        : [],
    ]);
    const brandNames = new Map(brands.map(brand => [brand.id, brand.name]));
    const colorNames = new Map(colors.map(color => [color.id, color.name]));
    for (const garment of garments) {
      garment.brandName = garment.brandId
        ? brandNames.get(garment.brandId)
        : undefined;
      garment.colorName = garment.colorId
        ? colorNames.get(garment.colorId)
        : undefined;
    }
    const [customer, addresses, phones, wallet] = await Promise.all([
      (await this.getCustomers()).findById(customerId),
      (await this.getAddresses()).find({
        where: {customerId, isDeleted: false, isActive: true},
        order: ['isDefault DESC', 'createdAt ASC'],
      }),
      (await this.getPhones()).find({
        where: {customerId, isDeleted: false, isActive: true},
        order: ['isPrimary DESC', 'createdAt ASC'],
      }),
      (await this.getWallets()).findOne({where: {customerId}}),
    ]);
    const fileName = `${randomUUID()}.pdf`;
    const directory = path.join(this.storageDirectory, 'order-summaries');
    await fs.mkdir(directory, {recursive: true});
    const filePath = path.join(directory, fileName);
    await fs.writeFile(
      filePath,
      await this.render(details, store, {
        customer,
        addresses,
        phone: phones[0]?.phone ?? details.order.customer?.phone,
        walletBalance: Number(wallet?.currentBalance ?? 0),
      }),
      {
        flag: 'wx',
        mode: 0o600,
      },
    );
    const expires = String(Math.floor(Date.now() / 1000) + configuredTtl);
    base.pathname = `${base.pathname.replace(/\/$/, '')}/documents/order-summaries/${fileName}`;
    base.searchParams.set('expires', expires);
    base.searchParams.set(
      'signature',
      this.signature(fileName, expires).toString('hex'),
    );
    return base.toString();
  }

  async readSigned(
    fileName: string,
    expires: string,
    signature: string,
  ): Promise<Buffer> {
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.pdf$/.test(
        fileName,
      ) ||
      !/^\d{10}$/.test(expires) ||
      !/^[a-f0-9]{64}$/.test(signature)
    )
      throw new HttpErrors.Forbidden('Invalid document link.');
    if (
      !timingSafeEqual(
        Buffer.from(signature, 'hex'),
        this.signature(fileName, expires),
      )
    ) {
      throw new HttpErrors.Forbidden('Invalid document link.');
    }
    if (Number(expires) <= Math.floor(Date.now() / 1000)) {
      throw new HttpErrors.Gone('This document link has expired.');
    }
    try {
      return await fs.readFile(
        path.join(this.storageDirectory, 'order-summaries', fileName),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new HttpErrors.NotFound('Document not found.');
      }
      throw error;
    }
  }

  private async render(
    details: SummaryDetails,
    store: Store,
    context: {
      customer: Customer;
      addresses: CustomerAddress[];
      phone?: string | null;
      walletBalance: number;
    },
  ): Promise<Buffer> {
    // Match thermal-receipt.js: 80 mm paper, 6 mm side insets, same field order.
    const width = (80 * 72) / 25.4;
    const inset = (6 * 72) / 25.4;
    const contentWidth = width - inset * 2;
    const doc = new PDFDocument({autoFirstPage: false, margin: 0});
    const measuringDoc = new PDFDocument({size: [width, 14400], margin: 0});
    const completed = new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });
    type Block = {height: number; draw: (top: number) => void};
    const blocks: Block[] = [];
    try {
      doc.registerFont(
        'Regular',
        path.join(__dirname, '../data/fonts/Roboto-Regular.ttf'),
      );
      doc.registerFont(
        'Bold',
        path.join(__dirname, '../data/fonts/Roboto-Bold.ttf'),
      );
      measuringDoc.registerFont(
        'Regular',
        path.join(__dirname, '../data/fonts/Roboto-Regular.ttf'),
      );
      measuringDoc.registerFont(
        'Bold',
        path.join(__dirname, '../data/fonts/Roboto-Bold.ttf'),
      );
      doc.info.Title = `Ticket ${details.order.orderNumber}`;
      doc.info.Author = 'Pressto';
      const text = (value: unknown): string =>
        value === undefined || value === null || value === ''
          ? '-'
          : String(value);
      const num = (value: unknown): number =>
        Number.isFinite(Number(value)) ? Number(value) : 0;
      const money = (value: unknown): string => num(value).toFixed(2);
      const whole = (value: unknown): string => String(Math.round(num(value)));
      const date = (value: unknown): string => {
        if (!value || Number.isNaN(new Date(String(value)).getTime()))
          return '-';
        const parsed = new Date(String(value));
        const parts = new Intl.DateTimeFormat('en-GB', {
          timeZone: 'Asia/Kolkata',
          weekday: 'short',
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          hour12: true,
        }).formatToParts(parsed);
        const part = (kind: string) =>
          parts.find(p => p.type === kind)?.value ?? '';
        return `${part('weekday')} ${part('day')}/${part('month')}/${part('year')} ${part('hour')}:${part('minute')} ${part('dayPeriod').toUpperCase()}`;
      };
      const font = (bold: boolean, size: number) =>
        doc
          .font(bold ? 'Bold' : 'Regular')
          .fontSize(size)
          .fillColor('black');
      const height = (
        value: string,
        cellWidth: number,
        bold = false,
        size = 8.25,
      ) => {
        measuringDoc.font(bold ? 'Bold' : 'Regular').fontSize(size);
        return measuringDoc.heightOfString(value, {
          width: cellWidth,
          lineGap: 1,
        });
      };
      const center = (value: string, bold = false, size = 8.25) => {
        const h = height(value, contentWidth, bold, size);
        blocks.push({
          height: h + 2,
          draw: top => {
            font(bold, size).text(value, inset, top, {
              width: contentWidth,
              align: 'center',
              lineGap: 1,
            });
          },
        });
      };
      const rule = (solid = false) =>
        blocks.push({
          height: 9,
          draw: top => {
            doc.lineWidth(0.5).strokeColor('black');
            if (!solid) doc.dash(2, {space: 2});
            doc
              .moveTo(inset, top + 4)
              .lineTo(width - inset, top + 4)
              .stroke()
              .undash();
          },
        });
      const pair = (
        label: string,
        value: unknown,
        bold = false,
        labelBold = false,
      ) => {
        const val = text(value);
        const leftWidth = Math.min(
          contentWidth * 0.62,
          Math.max(
            contentWidth * 0.36,
            doc.font('Bold').fontSize(8.25).widthOfString(label) + 3,
          ),
        );
        const rightWidth = contentWidth - leftWidth - 4;
        const h = Math.max(
          height(label, leftWidth, labelBold || bold),
          height(val, rightWidth, bold),
        );
        blocks.push({
          height: h + 3,
          draw: top => {
            font(labelBold || bold, 8.25).text(label, inset, top, {
              width: leftWidth,
              lineGap: 1,
            });
            font(bold, 8.25).text(val, inset + leftWidth + 4, top, {
              width: rightWidth,
              align: 'right',
              lineGap: 1,
            });
          },
        });
      };
      const field = (label: string, value: unknown) =>
        pair(label, value, false, true);
      const columns = [0.34, 0.14, 0.08, 0.1, 0.16, 0.18].map(
        ratio => ratio * contentWidth,
      );
      const tableRow = (cells: string[], heading = false) => {
        const size = heading ? 6.75 : 7.5;
        const h =
          Math.max(
            ...cells.map((cell, index) =>
              height(
                cell,
                columns[index] - 2,
                heading,
                index === 1 ? 6.75 : size,
              ),
            ),
          ) + 5;
        blocks.push({
          height: h,
          draw: top => {
            let x = inset;
            cells.forEach((cell, index) => {
              font(heading, index === 1 ? 6.75 : size).text(
                cell,
                x + 1,
                top + 2,
                {
                  width: columns[index] - 2,
                  align: index === 0 ? 'left' : index >= 4 ? 'right' : 'center',
                  lineGap: 1,
                },
              );
              x += columns[index];
            });
            if (heading)
              doc
                .lineWidth(0.5)
                .moveTo(inset, top + h - 1)
                .lineTo(width - inset, top + h - 1)
                .stroke();
          },
        });
      };
      const address = (value?: CustomerAddress) =>
        value
          ? [
              value.doorFloorFlat,
              value.societyName,
              value.addressLine1,
              value.addressLine2,
              value.landmark,
              value.city,
              value.state,
              value.country,
              value.pincode,
            ]
              .filter(Boolean)
              .join(', ')
          : '-';
      const order = details.order;
      const customer = context.customer;
      const defaultAddress = context.addresses.find(a => a.isDefault);
      const shipping =
        order.deliveryAddress ??
        address(
          context.addresses.find(a => a.id === order.deliveryAddressId) ??
            defaultAddress,
        );
      const billing = address(
        context.addresses.find(a => a.addressType === 'billing') ??
          defaultAddress,
      );
      // Same company constants and SAC code currently used by receipt-config.js.
      center('Press2 Drycleaning & Laundry Pvt. Ltd.', true, 9.75);
      center(
        [store.address, store.city, store.state, store.pincode]
          .filter(Boolean)
          .join(', '),
        false,
        7.5,
      );
      center('Tel No: 1800229199', false, 7.5);
      rule();
      pair('Store Name: ' + store.name, 'State Code: -');
      center('GSTN: 27AAECP3228Q2ZX', false, 7.5);
      rule();
      center('TICKET', true, 9);
      rule();
      field('Ticket #:', order.orderNumber);
      field('Date:', date(order.createdAt));
      field('Expected Delivery:', date(order.deliveryDate));
      field(
        'Delivery Type:',
        String(order.deliveryType ?? 'standard')
          .replace(/[_-]+/g, ' ')
          .replace(/\b\w/g, c => c.toUpperCase()),
      );
      field(
        'Order Type:',
        /p2d|pickup|home|online|web|whatsapp|call|delivery/.test(
          String(order.orderType).toLowerCase(),
        )
          ? 'P2D'
          : 'STORE',
      );
      field('Served By:', order.receivedByName);
      rule();
      center('CUSTOMER/CLIENT', true);
      rule();
      field('Customer Code:', customer.customerCode);
      field(
        'Customer Name:',
        [customer.firstName, customer.lastName].filter(Boolean).join(' '),
      );
      field('Tel No:', context.phone);
      field('Wallet Balance:', 'Rs. ' + money(context.walletBalance));
      if (customer.gstNumber) field('Customer GST Number:', customer.gstNumber);
      field('Billing Address:', billing === '-' ? shipping : billing);
      field('Shipping Address:', shipping);
      field('C.P.:', customer.notes);
      rule();
      const headings = [
        'Description',
        'HSN',
        'Qty',
        'Pend\nQty',
        'Rate',
        'Amount',
      ];
      tableRow(headings, true);
      let itemCount = 0;
      let serviceCount = 0;
      type Line = {cells: string[]; extras: ReceiptExtra[]; returned: boolean};
      const lines: Line[] = [];
      for (const item of details.items) {
        const quantity = Math.max(1, num(item.quantity));
        itemCount += quantity;
        const garments = item.garments ?? [];
        const pieceServices = Array.from(
          {length: quantity},
          (_, i) => garments[i]?.additionalServices ?? [],
        );
        const serviceSum = pieceServices
          .flat()
          .reduce((sum, extra) => sum + num(extra.amount), 0);
        const useBase =
          !item.isMeasurement &&
          Math.abs(
            num(item.unitPrice) * quantity + serviceSum - num(item.totalPrice),
          ) < 0.02;
        const areas = Array.from({length: quantity}, (_, i) => {
          const area = num(garments[i]?.length) * num(garments[i]?.width);
          return area > 0 ? area : 1;
        });
        const totalArea = areas.reduce((sum, area) => sum + area, 0);
        for (let i = 0; i < quantity; i++) {
          const garment = garments[i];
          const services = pieceServices[i];
          const charges = garment?.additionalCharges ?? [];
          serviceCount += 1 + services.length;
          const extraTotal = services.reduce(
            (sum, extra) => sum + num(extra.amount),
            0,
          );
          const area = item.isMeasurement ? areas[i] : 1;
          const base = item.isMeasurement
            ? (num(item.totalPrice) / totalArea) * area - extraTotal
            : useBase
              ? num(item.unitPrice)
              : num(item.totalPrice) / quantity - extraTotal;
          const description =
            [item.itemName, item.serviceName].filter(Boolean).join(' - ') ||
            '-';
          const instructions = garment?.customerRemarks ?? '';
          const packing = /^packaging(?=$|\s*[-\u2014])/i.test(
            instructions.trim(),
          )
            ? 'Packaging'
            : 'Hanger';
          const remarks = instructions
            .replace(
              /^(Hanging|Packaging)(,\s*(Hanging|Packaging))*\s*(\u2014\s*)?/i,
              '',
            )
            .trim();
          const metadata = [
            '+ ' + packing,
            garment?.brandName ? `Brand: ${garment.brandName}` : undefined,
            garment?.colorName ? `Color: ${garment.colorName}` : undefined,
            item.isMeasurement
              ? `Size: ${num(garment?.length)} ft x ${num(garment?.width)} ft`
              : undefined,
            remarks ? `Remark: ${remarks}` : undefined,
            garment?.inspectionRemarks
              ? `Inspection remarks: ${garment.inspectionRemarks}`
              : undefined,
          ]
            .filter(Boolean)
            .join('\n');
          const rejected = Boolean(item.rejectedAtIntake);
          const pending =
            rejected ||
            ['delivered', 'returned_to_customer'].includes(
              garment?.status ?? '',
            )
              ? 0
              : 1;
          lines.push({
            cells: [
              metadata ? description + '\n' + metadata : description,
              '999712',
              '1',
              String(pending),
              money(base / area),
              money(rejected ? 0 : base),
            ],
            extras: [...services, ...charges],
            returned: rejected,
          });
        }
        for (const charge of item.additionalCharges ?? []) {
          lines.push({
            cells: [
              '+ ' + text(charge.name),
              '-',
              '-',
              '-',
              money(num(charge.amount) / Math.max(1, num(charge.quantity))),
              money(item.rejectedAtIntake ? 0 : charge.amount),
            ],
            extras: [],
            returned: Boolean(item.rejectedAtIntake),
          });
        }
      }
      const renderLines = (rows: Line[]) => {
        const grouped = new Map<string, Line>();
        for (const line of rows) {
          const key = JSON.stringify([
            line.cells[0],
            line.cells[1],
            line.cells[4],
            line.cells[5],
            line.extras,
            line.returned,
            line.cells[2] === '-' ? grouped.size : undefined,
          ]);
          const existing = grouped.get(key);
          if (!existing) {
            grouped.set(key, {
              ...line,
              cells: [...line.cells],
              extras: line.extras.map(extra => ({...extra})),
            });
            continue;
          }
          existing.cells[2] = String(
            num(existing.cells[2]) + num(line.cells[2]),
          );
          existing.cells[3] = String(
            num(existing.cells[3]) + num(line.cells[3]),
          );
          existing.cells[5] = money(
            num(existing.cells[5]) + num(line.cells[5]),
          );
          existing.extras.forEach((extra, index) => {
            extra.amount = num(extra.amount) + num(line.extras[index].amount);
            extra.quantity =
              Math.max(1, num(extra.quantity)) +
              Math.max(1, num(line.extras[index].quantity));
          });
        }
        for (const line of grouped.values()) {
          tableRow(line.cells);
          for (const extra of line.extras) {
            const rate = num(extra.amount) / Math.max(1, num(extra.quantity));
            tableRow([
              '+ ' + text(extra.name),
              '-',
              '-',
              '-',
              money(rate),
              money(line.returned ? 0 : extra.amount),
            ]);
          }
        }
      };
      renderLines(lines.filter(line => !line.returned));
      if (!lines.some(line => !line.returned))
        tableRow(['-', '', '', '', '', '']);
      if (lines.some(line => line.returned)) {
        rule();
        center('RETURNED AT INTAKE', true);
        tableRow(headings, true);
        renderLines(lines.filter(line => line.returned));
      }
      rule();
      for (const charge of details.orderCharges ?? [])
        pair(text(charge.name), money(charge.amount));
      pair('Estimated Sub-Total:', money(order.subtotal));
      const discount = num(order.discountAmount);
      const discountRate =
        num(order.subtotal) > 0
          ? Number(((discount / num(order.subtotal)) * 100).toFixed(2))
          : 0;
      pair(
        discountRate > 0 ? `Discount @${discountRate}%` : 'Discount:',
        money(discount),
      );
      if (discount > 0)
        pair(
          'Estimated Discounted Total:',
          money(num(order.subtotal) - discount),
        );
      const cgst = Math.round(num(order.taxAmount) * 50) / 100;
      pair('Estimated CGST @9%', money(cgst));
      pair('Estimated SGST @9%', money(num(order.taxAmount) - cgst));
      rule(true);
      pair('TOTAL ESTIMATED VALUE (Rs.):', whole(order.totalAmount), true);
      rule(true);
      pair(
        'Payment Status:',
        details.totalCollected <= 0
          ? 'Unpaid'
          : Math.round(details.totalCollected) >=
              Math.round(num(order.totalAmount))
            ? 'Paid'
            : 'Partial Paid',
      );
      const paymentLabels: Record<string, string> = {
        cash: 'Cash',
        upi: 'UPI',
        card: 'Card',
        wallet: 'Wallet',
        ['bank_transfer']: 'Bank Transfer',
        ['net_banking']: 'Net Banking',
        cheque: 'Cheque',
        gateway: 'Payment Gateway',
        ['payment_link']: 'Payment Link',
        ['on_account']: 'On Account',
      };
      const payments = (details.paymentTransactions ?? []).filter(
        p => p.transactionType !== 'refund',
      );
      pair(
        'Payment Type:',
        [
          ...new Set(
            payments.map(
              p =>
                paymentLabels[p.paymentMode] ??
                p.paymentMode.replace(/_/g, ' '),
            ),
          ),
        ].join(', '),
      );
      pair('Collected Amount:', whole(details.totalCollected));
      const references = payments
        .map(p => p.transactionReference)
        .filter(Boolean)
        .join(', ');
      if (references) pair('Transaction Reference ID:', references);
      pair('Pending Amount:', whole(details.balanceDue), true);
      rule();
      pair('Items: ' + itemCount, 'Services: ' + serviceCount);
      rule();
      center('Thank you! Visit again', true);
      center('Free pickup & Drop: 1800229199', false, 7.5);
      // Measure before drawing so a normal ticket is one continuous thermal PDF.
      // Exceptionally long tickets split only between blocks, within PDF page limits.
      const pages: Block[][] = [[]];
      const pageHeights = [12];
      for (const block of blocks) {
        let page = pages.length - 1;
        if (pageHeights[page] + block.height > 14000) {
          pages.push([]);
          pageHeights.push(12);
          page++;
        }
        pages[page].push(block);
        pageHeights[page] += block.height;
      }
      pages.forEach((page, index) => {
        const pageHeight = pageHeights[index] + 17;
        doc.addPage({size: [width, pageHeight], margin: 0});
        let top = 3;
        for (const block of page) {
          block.draw(top);
          top += block.height;
        }
      });
      measuringDoc.destroy();
      doc.end();
    } catch (error) {
      doc.destroy();
      measuringDoc.destroy();
      throw error;
    }
    return completed;
  }
}
