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
import { ExecRequestDto } from './dto/exec-request.dto';

@Injectable()
export class ForwarderService {
  private readonly logger = new Logger(ForwarderService.name);
  private readonly allowedHosts: string[];
  private readonly defaultTimeout: number;
  private readonly maxResponseBytes: number;

  constructor(private readonly configService: ConfigService) {
    this.allowedHosts = (this.configService.get<string>('ALLOWED_HOSTS') || '')
      .split(',')
      .map((host) => host.trim().toLowerCase())
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

  async executeRequest(payload: ExecRequestDto): Promise<ForwarderResponse> {
    if (!this.isHostAllowed(payload.url)) {
      throw new BadRequestException('UPSTREAM_HOST_NOT_ALLOWED');
    }
    if (payload.rejectUnauthorized === false) {
      throw new BadRequestException('TLS_VALIDATION_REQUIRED');
    }
    if (
      payload.httpsAgent !== undefined &&
      !(payload.httpsAgent instanceof https.Agent)
    ) {
      throw new BadRequestException('INVALID_HTTPS_AGENT');
    }
    if (payload.httpsAgent?.options.rejectUnauthorized === false) {
      throw new BadRequestException('TLS_VALIDATION_REQUIRED');
    }
    const method = payload.method?.toUpperCase() || 'GET';
    const processedBody = this.processRequestBody(
      payload.body,
      payload.headers,
    );
    const config: AxiosRequestConfig = {
      url: payload.url,
      method,
      headers: this.stripContentTypeForGetRequests(
        this.stripHopByHopHeaders(payload.headers),
        method,
      ),
      responseType: 'arraybuffer',
      maxContentLength: this.maxResponseBytes,
      validateStatus: () => true,
      maxBodyLength:
        typeof payload.maxBodyLength === 'number' &&
        Number.isFinite(payload.maxBodyLength)
          ? payload.maxBodyLength
          : this.maxResponseBytes,
      httpsAgent: payload.cert
        ? new https.Agent({
            cert: payload.cert,
            key: payload.key || payload.cert,
            rejectUnauthorized: true,
          })
        : payload.httpsAgent || new https.Agent({ rejectUnauthorized: true }),
      timeout: payload.timeoutMs || payload.timeout || this.defaultTimeout,
    };
    if (processedBody) config.data = processedBody;
    if (payload.params) {
      config.params =
        payload.params instanceof URLSearchParams
          ? Object.fromEntries(payload.params.entries())
          : (payload.params as Record<string, unknown>);
    }
    if (payload.paramsSerializer)
      config.paramsSerializer =
        payload.paramsSerializer as AxiosRequestConfig['paramsSerializer'];

    try {
      const response = await axios.request<Buffer>(config);
      const responseBuffer = Buffer.from(response.data);
      const meta: ForwarderResponseMeta = {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      };
      const contentType = response.headers['content-type'] as
        string | undefined;
      if (this.looksLikeJson(contentType)) {
        return {
          ok: true,
          meta,
          bodyJson: JSON.parse(responseBuffer.toString('utf8')) as unknown,
        };
      }
      return {
        ok: true,
        meta,
        bodyBase64: responseBuffer.toString('base64'),
        bodyEncoding: 'base64',
      };
    } catch {
      // Axios errors may include authorization headers, URLs and request bodies.
      this.logger.error('REQUEST_EXECUTION_FAILED');
      throw new InternalServerErrorException({
        ok: false,
        error: 'REQUEST_EXECUTION_FAILED',
      });
    }
  }

  private processRequestBody(
    body: unknown,
    headers: Record<string, string> = {},
  ): unknown {
    if (!body) return body;
    const contentType =
      headers['content-type'] || headers['Content-Type'] || '';
    if (
      contentType.toLowerCase().includes('application/x-www-form-urlencoded')
    ) {
      if (body instanceof URLSearchParams) return body.toString();
      if (typeof body === 'object')
        return qs.stringify(body as qs.ParsedUrlQueryInput);
    }
    return body;
  }

  private isHostAllowed(targetUrl: string): boolean {
    try {
      const host = new URL(targetUrl).hostname.toLowerCase();
      return (
        this.allowedHosts.length === 0 ||
        this.allowedHosts.some(
          (allowed) => host === allowed || host.endsWith(`.${allowed}`),
        )
      );
    } catch {
      return false;
    }
  }

  private stripHopByHopHeaders(
    headers: Record<string, string> = {},
  ): Record<string, string> {
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
    return Object.fromEntries(
      Object.entries(headers).filter(
        ([header]) => !hopByHop.has(header.toLowerCase()),
      ),
    );
  }

  private stripContentTypeForGetRequests(
    headers: Record<string, string>,
    method: string,
  ): Record<string, string> {
    if (method !== 'GET') return headers;
    return Object.fromEntries(
      Object.entries(headers).filter(
        ([header]) => header.toLowerCase() !== 'content-type',
      ),
    );
  }

  private looksLikeJson(contentType?: string): boolean {
    return !!contentType && /application\/json|\+json/i.test(contentType);
  }
}
