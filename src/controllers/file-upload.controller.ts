import {authenticate} from '@loopback/authentication';
import {inject} from '@loopback/core';
import {repository} from '@loopback/repository';
import {
  get,
  HttpErrors,
  oas,
  param,
  post,
  Request,
  requestBody,
  Response,
  RestBindings,
} from '@loopback/rest';
import {randomUUID} from 'crypto';
import fs from 'fs';
import {FILE_UPLOAD_SERVICE, STORAGE_DIRECTORY} from '../keys';
import {MediaRepository} from '../repositories';
import {FileUploadHandler} from '../types';
import {
  MAX_UPLOAD_BYTES,
  resolvePublicFilePath,
  resolveUploadExtension,
} from '../utils/file-upload-policy';
import * as mime from 'mime-types';

/**
 * A controller to handle file uploads using multipart/form-data media type
 */
export class FileUploadController {
  constructor(
    @inject(FILE_UPLOAD_SERVICE) private handler: FileUploadHandler,
    @inject(STORAGE_DIRECTORY) private storageDirectory: string,
    @repository(MediaRepository)
    private mediaRepository: MediaRepository
  ) { }

  private async saveUploads(
    request: Request,
    response: Response,
  ): Promise<object> {
    const multer = require('multer');
    const storage = multer.diskStorage({
      destination: this.storageDirectory,
      filename: (req: Request, file: Express.Multer.File, cb: Function) => {
        const extension = resolveUploadExtension(
          file.originalname,
          file.mimetype,
        );
        cb(null, `${randomUUID()}${extension}`);
      },
    });

    const handler = multer({
      storage,
      limits: {fileSize: MAX_UPLOAD_BYTES},
      fileFilter: (
        req: Request,
        file: Express.Multer.File,
        cb: (error: Error | null, accept?: boolean) => void,
      ) => {
        if (resolveUploadExtension(file.originalname, file.mimetype)) {
          cb(null, true);
        } else {
          cb(new HttpErrors.UnsupportedMediaType('This file type is not allowed.'));
        }
      },
    }).any();

    return new Promise<object>((resolve, reject) => {
      handler(request, response, (err: unknown) => {
        if ((err as {code?: string} | undefined)?.code === 'LIMIT_FILE_SIZE') {
          reject(new HttpErrors.PayloadTooLarge('File is too large.'));
        } else if (err instanceof HttpErrors.HttpError) {
          reject(err);
        } else if (err) {
          reject(new HttpErrors.InternalServerError('Upload failed'));
        } else {
          resolve(FileUploadController.getFilesAndFields(request));
        }
      });
    });
  }

  @authenticate('jwt')
  @post('/files')
  async uploadToRoot(
    @requestBody.file() request: Request,
    @inject(RestBindings.Http.RESPONSE) response: Response,
  ): Promise<object> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = await this.saveUploads(request, response);

    const filesWithIds = [];

    for (const file of result.files) {
      const saved = await this.mediaRepository.create({
        fileOriginalName: file.fileName,
        fileName: file.newFileName,
        fileUrl: file.fileUrl,
        fileLocation: file.location,
        fileType: file.mimetype,
        isUsed: false,
      });

      filesWithIds.push({
        id: saved.id,
        fileUrl: saved.fileUrl,
        fileName: saved.fileOriginalName,
      });
    }

    return {
      files: filesWithIds,
      fields: result.fields
    };
  }


  /**
   * Get files and fields for the request
   * @param request - Http request
   */
  // private static getFilesAndFields(request: Request) {
  //   const uploadedFiles = request.files;
  //   const mapper = (f: globalThis.Express.Multer.File) => {
  //     return {
  //       fieldname: f.fieldname,
  //       fileName: f.originalname,
  //       newFileName: f.filename,
  //       fileUrl: `${process.env.API_ENDPOINT}/files/${f.filename}`, // Use f.filename instead of f.originalname
  //       encoding: f.encoding,
  //       mimetype: f.mimetype,
  //       size: f.size,
  //     };
  //   };
  //   let files: object[] = [];
  //   if (Array.isArray(uploadedFiles)) {
  //     files = uploadedFiles.map(mapper);
  //   } else {
  //     for (const filename in uploadedFiles) {
  //       files.push(...uploadedFiles[filename].map(mapper));
  //     }
  //   }

  //   return {files, fields: request.body};
  // }

  @get('/files/file/{path}/{fileName}')
  @oas.response.file()
  async downloadFile(
    @param.path.string('path') folderPath: string,
    @param.path.string('fileName') fileName: string,
    @inject(RestBindings.Http.RESPONSE) response: Response,
  ) {
    const file = this.validateFileName(`${folderPath}/${fileName}`);

    return new Promise<void>((resolve) => {
      fs.readFile(file, (err, data) => {
        if (err) {
          response.status(404).send('Something Went Wrong');
          return resolve();
        }

        response.setHeader('Content-Type', 'application/octet-stream');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        response.status(200).end(data);

        resolve();
      });
    });
  }

  @get('/files/file/{fileName}')
  @oas.response.file()
  async downloadFileOutsideFolder(
    @param.path.string('fileName') fileName: string,
    @inject(RestBindings.Http.RESPONSE) response: Response,
  ) {
    const file = this.validateFileName(fileName);

    return new Promise<void>((resolve) => {
      fs.readFile(file, (err, data) => {
        if (err) {
          response.status(404).send('File not found');
          return resolve();
        }

        const contentType = mime.lookup(fileName) || 'application/octet-stream';
        response.setHeader('Content-Type', contentType);
        response.setHeader('X-Content-Type-Options', 'nosniff');

        // ❌ No Content-Disposition (browser will preview if possible)
        response.status(200).end(data);
        resolve();
      });
    });
  }


  /**
   * Validate file names to prevent them goes beyond the designated directory
   * @param fileName - File name
   */
  private validateFileName(filePath: string): string {
    const resolved = resolvePublicFilePath(this.storageDirectory, filePath);

    if (!resolved || !fs.existsSync(resolved)) {
      throw new HttpErrors.NotFound('File not found');
    }

    return resolved;
  }

  private static getFilesAndFields(request: Request) {
    const uploadedFiles = request.files;
    const mapper = (f: Express.Multer.File) => ({
      fieldname: f.fieldname,
      fileName: f.originalname,
      newFileName: f.filename,
      fileUrl: `${process.env.API_ENDPOINT}/files/file/${encodeURIComponent(f.filename)}`,
      encoding: f.encoding,
      mimetype: f.mimetype,
      size: f.size,
      location: f.path,
    });

    let files: object[] = [];
    if (Array.isArray(uploadedFiles)) {
      files = uploadedFiles.map(mapper);
    } else {
      for (const filename in uploadedFiles) {
        files.push(...uploadedFiles[filename].map(mapper));
      }
    }

    return {files, fields: request.body};
  }
}
