import {getAuthenticateMetadata} from '@loopback/authentication';
import {expect} from '@loopback/testlab';
import path from 'path';
import {FileUploadController} from '../controllers/file-upload.controller';
import {
  resolvePublicFilePath,
  resolveUploadExtension,
} from '../utils/file-upload-policy';

describe('File upload policy', () => {
  const root = path.resolve('/srv/storage');

  describe('resolvePublicFilePath', () => {
    it('allows files in the storage root', () => {
      expect(resolvePublicFilePath(root, 'photo.jpg')).to.equal(
        path.join(root, 'photo.jpg'),
      );
    });

    for (const folder of ['order-summaries', 'invoices', 'payment-receipts']) {
      it(`blocks the ${folder} folder`, () => {
        expect(resolvePublicFilePath(root, `${folder}/a.pdf`)).to.be.null();
      });
    }

    it('blocks customer documents reached through dot segments or case', () => {
      for (const requested of [
        './order-summaries/a.pdf',
        'x/../invoices/a.pdf',
        'Order-Summaries/a.pdf',
      ]) {
        expect(resolvePublicFilePath(root, requested)).to.be.null();
      }
    });

    it('blocks paths outside the root, including sibling folders', () => {
      for (const requested of [
        '../.env',
        '../storage-other/a.jpg',
        path.resolve('/etc/passwd'),
        '',
      ]) {
        expect(resolvePublicFilePath(root, requested)).to.be.null();
      }
    });
  });

  describe('resolveUploadExtension', () => {
    it('keeps allowed extensions, lowercased', () => {
      expect(resolveUploadExtension('selfie.JPG', 'image/jpeg')).to.equal(
        '.jpg',
      );
      expect(resolveUploadExtension('scan.jfif', 'image/jpeg')).to.equal(
        '.jfif',
      );
    });

    it('accepts the customer site voice note formats', () => {
      for (const [name, mime, extension] of [
        ['voice-1.webm', 'audio/webm;codecs=opus', '.webm'],
        ['voice-1.mp4', 'audio/mp4', '.mp4'],
        ['voice-1.ogg', 'audio/ogg;codecs=opus', '.ogg'],
      ]) {
        expect(resolveUploadExtension(name, mime)).to.equal(extension);
      }
    });

    it('falls back to the MIME type when the name has no extension', () => {
      expect(resolveUploadExtension('blob', 'image/jpeg')).to.equal('.jpg');
      expect(resolveUploadExtension('blob', 'audio/webm;codecs=opus')).to.equal(
        '.webm',
      );
    });

    it('rejects types a browser could execute', () => {
      for (const [name, mime] of [
        ['x.html', 'text/html'],
        ['x.svg', 'image/svg+xml'],
        ['x.js', 'text/javascript'],
        ['x', 'application/octet-stream'],
      ]) {
        expect(resolveUploadExtension(name, mime)).to.be.null();
      }
    });

    it('never keeps a dangerous name even with an allowed MIME type', () => {
      expect(resolveUploadExtension('x.html', 'image/png')).to.equal('.png');
    });
  });

  describe('FileUploadController routes', () => {
    it('requires a JWT to upload', () => {
      const metadata = getAuthenticateMetadata(
        FileUploadController,
        'uploadToRoot',
      );
      expect(metadata?.[0].strategy).to.equal('jwt');
    });

    it('no longer exposes listing or folder upload handlers', () => {
      for (const removed of [
        'listFiles',
        'listFolderFiles',
        'uploadWithProcessId',
      ]) {
        expect(
          (FileUploadController.prototype as unknown as Record<string, unknown>)[
            removed
          ],
        ).to.be.undefined();
      }
    });
  });
});
