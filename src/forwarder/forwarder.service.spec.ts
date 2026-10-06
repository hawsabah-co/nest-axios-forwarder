import { BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import * as https from 'https';
import { ForwarderService } from './forwarder.service';
import { ExecRequestDto } from './dto/exec-request.dto';

jest.mock('axios');
const request = jest.mocked(axios.request);
const fixtureSecret = 'fake-fixture-secret-must-not-appear-in-logs';
const payload = (): ExecRequestDto => ({
  url: `https://example.test/echo?secret=${fixtureSecret}`,
  method: 'POST',
  headers: { Authorization: `Bearer ${fixtureSecret}` },
  body: { secret: fixtureSecret },
  maxBodyLength: 1024,
});
const response = (status: number, body: Buffer, contentType: string) => ({
  status,
  statusText: 'Fixture status',
  data: body,
  headers: { 'content-type': contentType },
});

describe('ForwarderService transport and confidentiality contract', () => {
  let service: ForwarderService;
  let errors: jest.SpyInstance;
  let output: jest.SpyInstance;
  beforeEach(() => {
    jest.clearAllMocks();
    service = new ForwarderService(
      new ConfigService({ ALLOWED_HOSTS: 'example.test' }),
    );
    errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    output = jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it('preserves mTLS certificate and separate key with verification enabled', async () => {
    request.mockResolvedValue(
      response(200, Buffer.from('{}'), 'application/json'),
    );
    await service.executeRequest({
      ...payload(),
      cert: 'fake-client-certificate',
      key: fixtureSecret,
    });
    const agent = request.mock.calls[0][0].httpsAgent as https.Agent;
    expect(agent).toBeInstanceOf(https.Agent);
    expect(agent.options).toMatchObject({
      cert: 'fake-client-certificate',
      key: fixtureSecret,
      rejectUnauthorized: true,
    });
    expect(output).not.toHaveBeenCalled();
  });

  it('preserves the upstream combined certificate/key bundle convention', async () => {
    request.mockResolvedValue(
      response(200, Buffer.from('{}'), 'application/json'),
    );
    await service.executeRequest({ ...payload(), cert: fixtureSecret });
    expect(
      (request.mock.calls[0][0].httpsAgent as https.Agent).options,
    ).toMatchObject({
      cert: fixtureSecret,
      key: fixtureSecret,
      rejectUnauthorized: true,
    });
  });

  it.each([undefined, true])(
    'preserves a real caller Agent with TLS option %s',
    async (rejectUnauthorized) => {
      const agent = new https.Agent({ rejectUnauthorized });
      try {
        request.mockResolvedValue(
          response(200, Buffer.from('{}'), 'application/json'),
        );
        await service.executeRequest({ ...payload(), httpsAgent: agent });
        expect(request.mock.calls[0][0].httpsAgent).toBe(agent);
      } finally {
        agent.destroy();
      }
    },
  );

  it('rejects an actual caller Agent with verification disabled', async () => {
    const agent = new https.Agent({ rejectUnauthorized: false });
    try {
      await expect(
        service.executeRequest({ ...payload(), httpsAgent: agent }),
      ).rejects.toThrow('TLS_VALIDATION_REQUIRED');
      expect(request).not.toHaveBeenCalled();
    } finally {
      agent.destroy();
    }
  });

  it('rejects HTTP JSON objects claiming to be an Agent without exposing their contents', async () => {
    const fakeAgent = {
      cert: fixtureSecret,
      key: fixtureSecret,
    } as unknown as https.Agent;
    await expect(
      service.executeRequest({ ...payload(), httpsAgent: fakeAgent }),
    ).rejects.toThrow('INVALID_HTTPS_AGENT');
    expect(request).not.toHaveBeenCalled();
  });

  it('preserves upstream URLSearchParams normalization and custom serializer', async () => {
    request.mockResolvedValue(
      response(200, Buffer.from('{}'), 'application/json'),
    );
    const params = new URLSearchParams([
      ['filter', 'first'],
      ['filter', 'last'],
      ['query', 'a b'],
    ]);
    const serializer = () => 'fixture-query';
    await service.executeRequest({
      ...payload(),
      params,
      paramsSerializer: serializer,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ amount: '1.00', reference: 'a b' }),
    });
    expect(request.mock.calls[0][0]).toMatchObject({
      params: { filter: 'last', query: 'a b' },
      paramsSerializer: serializer,
      data: 'amount=1.00&reference=a+b',
    });
  });

  it('preserves plain query parameters without mutation', async () => {
    request.mockResolvedValue(
      response(200, Buffer.from('{}'), 'application/json'),
    );
    const params = { filter: ['first', 'last'], query: 'a b' };
    await service.executeRequest({ ...payload(), params });
    expect(request.mock.calls[0][0].params).toBe(params);
    expect(params).toEqual({ filter: ['first', 'last'], query: 'a b' });
  });

  it.each([undefined, true])(
    'creates a real verified TLS agent for option %s',
    async (option) => {
      request.mockResolvedValue(
        response(200, Buffer.from('{}'), 'application/json'),
      );
      await service.executeRequest({
        ...payload(),
        rejectUnauthorized: option,
      });
      const config = request.mock.calls[0][0];
      expect(config.httpsAgent).toBeInstanceOf(https.Agent);
      expect(
        (config.httpsAgent as https.Agent).options.rejectUnauthorized,
      ).toBe(true);
    },
  );

  it('rejects a request to disable TLS verification before transport', async () => {
    await expect(
      service.executeRequest({ ...payload(), rejectUnauthorized: false }),
    ).rejects.toThrow('TLS_VALIDATION_REQUIRED');
    expect(request).not.toHaveBeenCalled();
  });

  it('wraps upstream 401 JSON as metadata instead of a caller authentication error', async () => {
    request.mockResolvedValue(
      response(
        401,
        Buffer.from('{"result":{"code":"fixture-auth-denied"}}'),
        'application/json',
      ),
    );
    const result = await service.executeRequest(payload());
    expect(result).toMatchObject({
      ok: true,
      meta: { status: 401 },
      bodyJson: { result: { code: 'fixture-auth-denied' } },
    });
    expect(request.mock.calls[0][0].validateStatus?.(401)).toBe(true);
    expect(output).not.toHaveBeenCalled();
  });

  it('preserves binary and non-JSON responses without trying to parse them as JSON', async () => {
    const bytes = Buffer.from([0, 255, 128, 13]);
    request.mockResolvedValue(response(200, bytes, 'application/octet-stream'));
    expect(await service.executeRequest(payload())).toMatchObject({
      ok: true,
      bodyBase64: bytes.toString('base64'),
      bodyEncoding: 'base64',
    });
  });

  it('keeps form encoding and removes hop-by-hop headers', async () => {
    request.mockResolvedValue(
      response(200, Buffer.from('{}'), 'application/json'),
    );
    await service.executeRequest({
      ...payload(),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Connection: 'keep-alive',
      },
      body: { amount: '1.00', reference: 'a b' },
    });
    expect(request.mock.calls[0][0]).toMatchObject({
      data: 'amount=1.00&reference=a%20b',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    expect(request.mock.calls[0][0].headers).not.toHaveProperty('Connection');
  });

  it('rejects a disallowed host without exposing its private URL', async () => {
    await expect(
      service.executeRequest({
        ...payload(),
        url: `https://denied.test/?secret=${fixtureSecret}`,
      }),
    ).rejects.toEqual(expect.any(BadRequestException));
    expect(request).not.toHaveBeenCalled();
  });

  it('reports transport failure without logging or returning credentials or payloads', async () => {
    request.mockRejectedValue(
      Object.assign(new Error(fixtureSecret), {
        config: payload(),
        response: { data: fixtureSecret },
      }),
    );
    let exception: unknown;
    try {
      await service.executeRequest(payload());
    } catch (error) {
      exception = error;
    }
    expect(exception).toMatchObject({
      response: { ok: false, error: 'REQUEST_EXECUTION_FAILED' },
    });
    expect(errors).toHaveBeenCalledWith('REQUEST_EXECUTION_FAILED');
    expect(JSON.stringify(errors.mock.calls)).not.toContain(fixtureSecret);
    expect(JSON.stringify(exception)).not.toContain(fixtureSecret);
    expect(output).not.toHaveBeenCalled();
  });
});
