// src/forwarder/forwarder.service.ts
import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as qs from 'querystring';
import axios, { AxiosRequestConfig } from 'axios';
import * as https from 'https';

import type {
  ForwarderResponse,
  ForwarderResponseMeta,
} from './interfaces/forwarder-response.interface';
// Import the new interface
import { ExecRequestDto } from './dto/exec-request.dto';

@Injectable()
export class ForwarderService {
  private readonly logger = new Logger(ForwarderService.name);
  private readonly allowedHosts: string[];
  private readonly defaultTimeout: number;
  private readonly maxResponseBytes: number;

  constructor(private readonly configService: ConfigService) {
    const hosts = this.configService.get<string>('ALLOWED_HOSTS') || '';
    this.allowedHosts = hosts
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    this.defaultTimeout = this.configService.get<number>(
      'UPSTREAM_TIMEOUT_MS',
      30000,
    );
    this.maxResponseBytes = this.configService.get<number>(
      'MAX_RESPONSE_BYTES',
      5242880,
    );
  }

  // Add the explicit return type here
  async executeRequest(payload: ExecRequestDto): Promise<ForwarderResponse> {
    if (!this.isHostAllowed(payload.url)) {
      throw new BadRequestException(
        `Host for URL ${payload.url} is not allowed.`,
      );
    }
    // Process the request body based on content type
    const processedBody = this.processRequestBody(
      payload.body,
      payload.headers,
    );
    const config: AxiosRequestConfig = {
      url: payload.url,
      method: payload.method || 'GET',
      headers: this.stripContentTypeForGetRequests(
        this.stripHopByHopHeaders(payload.headers),
        payload.method?.toUpperCase() || 'GET',
      ),
      // timeout: payload.timeoutMs || this.defaultTimeout,
      responseType: 'arraybuffer',
      maxContentLength: this.maxResponseBytes,
      validateStatus: () => true,
      maxBodyLength:
        typeof payload.maxBodyLength === 'number' &&
        Number.isFinite(payload.maxBodyLength)
          ? payload.maxBodyLength
          : this.maxResponseBytes,
    };
    if (processedBody) {
      config.data = processedBody;
    }
    if (payload.params) {
      // Convert URLSearchParams to plain object if needed
      if (payload.params instanceof URLSearchParams) {
        const paramsObj: Record<string, any> = {};
        payload.params.forEach((value, key) => {
          paramsObj[key] = value;
        });
        config.params = paramsObj;
      } else {
        config.params = payload.params as Record<string, any>;
      }
    }
    if (payload.paramsSerializer) {
      config.paramsSerializer =
        payload.paramsSerializer as AxiosRequestConfig['paramsSerializer'];
    }
    // Handle httpsAgent - create from cert data if provided
    console.log('Checking cert/key fields:', {
      hasCert: !!payload.cert,
      hasKey: !!payload.key,
      certLength: payload.cert?.length,
      rejectUnauthorized: payload.rejectUnauthorized,
    });

    if (payload.cert) {
      console.log('Creating HTTPS agent with certificate');
      config.httpsAgent = new https.Agent({
        cert: payload.cert,
        key: payload.key || payload.cert, // Use key if provided, otherwise cert contains both
        rejectUnauthorized: payload.rejectUnauthorized !== false,
      });
    } else if (payload.httpsAgent) {
      console.log('Using provided httpsAgent');
      config.httpsAgent = payload.httpsAgent;
    } else {
      console.log('Creating default HTTPS agent');
      const rejectUnauthorized = payload.rejectUnauthorized !== false; // default to true
      config.httpsAgent = new https.Agent({ rejectUnauthorized });
    }
    // Handle both timeout and timeoutMs for backward compatibility
    const timeoutValue =
      payload.timeoutMs || payload.timeout || this.defaultTimeout;
    config.timeout = timeoutValue;
    console.log('Final axios config:', config);
    try {
      const response = await axios.request(config);
      const responseBuffer = Buffer.from(response.data);
      const meta: ForwarderResponseMeta = {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers, // This assignment is safe
      };
      console.log('response status:', response.status);
      console.log('response headers:', response.headers);

      const contentType = response.headers['content-type'] as string;
      if (this.looksLikeJson(contentType)) {
        try {
          const bodyJson = JSON.parse(responseBuffer.toString('utf8'));
          console.log('Parsed JSON response:', bodyJson);
          return {
            ok: true,
            meta,
            bodyJson,
          };
        } catch (error) {
          /* Fallback to base64 */
          this.logger.error('Failed to parse JSON response', error);
          throw error;
        }
      }

      console.log('Non-JSON response, returning as base64');
      return {
        ok: true,
        meta,
        bodyBase64: responseBuffer.toString('base64'),
        bodyEncoding: 'base64',
      };
    } catch (error: unknown) {
      if (error instanceof Error) {
        this.logger.error('Request execution failed', error);
      } else {
        this.logger.error('Request execution failed', new Error(String(error)));
      }
      let errMsg = 'Unknown error';
      if (axios.isAxiosError(error)) {
        errMsg = error.message;
      } else if (error instanceof Error) {
        errMsg = error.message;
      }
      throw new InternalServerErrorException({
        ok: false,
        error: 'REQUEST_EXECUTION_FAILED',
        details: errMsg,
      });
    }
  }

  private processRequestBody(
    body: unknown,
    headers: Record<string, string> = {},
  ): unknown {
    console.log('processRequestBody called with body:', body);
    console.log('processRequestBody body type:', typeof body);
    console.log('processRequestBody body is null:', body === null);
    console.log('processRequestBody body is undefined:', body === undefined);
    console.log(
      'processRequestBody body constructor:',
      body?.constructor?.name,
    );

    if (!body) {
      console.log('Body is falsy, returning as is');
      return body;
    }

    // Reconstruct Buffer if serialized over JSON as { type: 'Buffer', data: number[] }
    if (
      typeof body === 'object' &&
      body !== null &&
      (body as any).type === 'Buffer' &&
      Array.isArray((body as any).data)
    ) {
      console.log('Reconstructing Buffer from serialized Buffer object');
      return Buffer.from((body as any).data);
    }

    // Reconstruct Buffer if serialized over JSON as { type: 'base64', data: string }
    if (
      typeof body === 'object' &&
      body !== null &&
      (body as any).type === 'base64' &&
      typeof (body as any).data === 'string'
    ) {
      console.log('Reconstructing Buffer from base64 string payload');
      return Buffer.from((body as any).data, 'base64');
    }

    if (Buffer.isBuffer(body)) {
      console.log('Body is already a Buffer, returning as is');
      return body;
    }

    const contentType =
      headers['content-type'] || headers['Content-Type'] || '';
    console.log('Content-Type detected:', contentType);

    // If content type is application/x-www-form-urlencoded, serialize the body
    if (
      contentType.toLowerCase().includes('application/x-www-form-urlencoded')
    ) {
      console.log('Form URL encoded content type detected');

      // Handle URLSearchParams objects
      if (body instanceof URLSearchParams) {
        console.log('Body is URLSearchParams, converting to string');
        const result = body.toString();
        console.log('URLSearchParams result:', result);
        return result;
      } else if (typeof body === 'object' && body !== null) {
        console.log('Converting object body to URL-encoded string');
        const result = qs.stringify(body as Record<string, any>);
        console.log('URL-encoded result:', result);
        return result;
      } else if (typeof body === 'string') {
        console.log('Body is already a string, returning as is');
        return body;
      }
    }

    console.log('Returning body unchanged');
    return body;
  }

  // ... (rest of the helper methods are unchanged)
  private isHostAllowed(targetUrl: string): boolean {
    try {
      const url = new URL(targetUrl);
      const host = url.hostname.toLowerCase();
      if (this.allowedHosts.length === 0) return true;
      return this.allowedHosts.some(
        (allowed) => host === allowed || host.endsWith(`.${allowed}`),
      );
    } catch {
      return false;
    }
  }

  private stripHopByHopHeaders(headers: Record<string, string> = {}) {
    const hopByHop = new Set([
      'connection',
      'keep-alive',
      'proxy-authenticate',
      'proxy-authorization',
      'te',
      'trailer',
      'transfer-encoding',
      'upgrade',
    ]);
    const result = { ...headers };
    for (const header in result) {
      if (hopByHop.has(header.toLowerCase())) {
        delete result[header];
      }
    }
    return result;
  }

  private stripContentTypeForGetRequests(
    headers: Record<string, string> = {},
    method: string = 'GET',
  ) {
    if (method?.toUpperCase() === 'GET') {
      const result = { ...headers };
      // Remove Content-Type for GET requests as it can confuse some APIs like WHM
      for (const header in result) {
        if (header.toLowerCase() === 'content-type') {
          delete result[header];
        }
      }
      return result;
    }
    return headers;
  }

  private looksLikeJson(contentType?: string): boolean {
    return !!contentType && /application\/json|\+json/i.test(contentType);
  }
}
