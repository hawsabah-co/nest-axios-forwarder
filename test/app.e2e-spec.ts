import { Test } from '@nestjs/testing';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import request from 'supertest';
import { AppModule } from './../src/app.module';

describe('Forwarder endpoint (isolated loopback e2e)', () => {
  let app: NestExpressApplication;
  let upstream: Server;
  let baseUrl: string;
  let upstreamCalls = 0;
  const fixtureSecret = 'fake-forwarder-e2e-private-marker';
  const binary = Buffer.from([0, 255, 128, 13]);
  let log: jest.SpyInstance;
  let errorLog: jest.SpyInstance;

  beforeAll(async () => {
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    errorLog = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});
    upstream = createServer((req, res) => {
      upstreamCalls++;
      if (req.url === '/binary') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(binary);
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            fixture: true,
            url: req.url,
            authorization: req.headers.authorization,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      });
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, '127.0.0.1', resolve),
    );
    baseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ConfigService)
      .useValue(
        new ConfigService({
          ALLOWED_HOSTS: '127.0.0.1',
          ALLOWED_CLIENTS: '127.0.0.1',
        }),
      )
      .compile();
    app = module.createNestApplication<NestExpressApplication>();
    app.useLogger(false);
    app.useBodyParser('json', { limit: '10mb' });
    app.useBodyParser('urlencoded', { limit: '10mb', extended: true });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    if (upstream?.listening)
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    jest.restoreAllMocks();
  });

  it('forwards form bytes and wraps an upstream 401 in successful caller metadata', async () => {
    const response = await request(app.getHttpServer())
      .post('/forwarder/exec')
      .send({
        url: `${baseUrl}/form`,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${fixtureSecret}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: { amount: '1.00', reference: 'a b' },
      })
      .expect(201);
    expect(response.body).toMatchObject({
      ok: true,
      meta: { status: 401 },
      bodyJson: {
        fixture: true,
        authorization: `Bearer ${fixtureSecret}`,
        body: 'amount=1.00&reference=a%20b',
      },
    });
    expect(
      JSON.stringify([...log.mock.calls, ...errorLog.mock.calls]),
    ).not.toContain(fixtureSecret);
  });

  it('preserves a binary upstream response', async () => {
    const response = await request(app.getHttpServer())
      .post('/forwarder/exec')
      .send({ url: `${baseUrl}/binary`, method: 'GET' })
      .expect(201);
    expect(response.body).toMatchObject({
      ok: true,
      meta: { status: 200 },
      bodyBase64: binary.toString('base64'),
      bodyEncoding: 'base64',
    });
  });

  it('rejects TLS-disable requests before reaching the upstream', async () => {
    const before = upstreamCalls;
    const response = await request(app.getHttpServer())
      .post('/forwarder/exec')
      .send({ url: `${baseUrl}/form`, rejectUnauthorized: false })
      .expect(400);
    expect(response.body.message).toBe('TLS_VALIDATION_REQUIRED');
    expect(upstreamCalls).toBe(before);
  });

  it('rejects disallowed hosts without reaching any upstream', async () => {
    const before = upstreamCalls;
    const response = await request(app.getHttpServer())
      .post('/forwarder/exec')
      .send({ url: `https://blocked-fixture.invalid/?secret=${fixtureSecret}` })
      .expect(400);
    expect(response.body.message).toBe('UPSTREAM_HOST_NOT_ALLOWED');
    expect(upstreamCalls).toBe(before);
    expect(JSON.stringify(response.body)).not.toContain(fixtureSecret);
  });

  it('rejects unknown top-level body fields before transport', async () => {
    const before = upstreamCalls;
    await request(app.getHttpServer())
      .post('/forwarder/exec')
      .send({ url: `${baseUrl}/form`, unexpected: fixtureSecret })
      .expect(400);
    expect(upstreamCalls).toBe(before);
  });

  it('accepts certificate/key DTO fields and ordinary query parameters', async () => {
    const response = await request(app.getHttpServer())
      .post('/forwarder/exec')
      .send({
        url: `${baseUrl}/params`,
        method: 'GET',
        params: { query: 'a b' },
        cert: 'fake-client-certificate',
        key: fixtureSecret,
      })
      .expect(201);
    expect(response.body).toMatchObject({
      ok: true,
      bodyJson: { url: '/params?query=a+b' },
    });
    expect(
      JSON.stringify([...log.mock.calls, ...errorLog.mock.calls]),
    ).not.toContain(fixtureSecret);
  });

  it('rejects serialized httpsAgent objects safely before any upstream request', async () => {
    const before = upstreamCalls;
    const response = await request(app.getHttpServer())
      .post('/forwarder/exec')
      .send({ url: `${baseUrl}/form`, httpsAgent: { key: fixtureSecret } })
      .expect(400);
    expect(response.body.message).toBe('INVALID_HTTPS_AGENT');
    expect(JSON.stringify(response.body)).not.toContain(fixtureSecret);
    expect(upstreamCalls).toBe(before);
  });

  it('keeps the upstream large JSON payload parser contract', async () => {
    const data = 'x'.repeat(150000);
    const response = await request(app.getHttpServer())
      .post('/forwarder/exec')
      .send({
        url: `${baseUrl}/large`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { data },
      })
      .expect(201);
    expect(JSON.parse(response.body.bodyJson.body)).toEqual({ data });
  });
});
