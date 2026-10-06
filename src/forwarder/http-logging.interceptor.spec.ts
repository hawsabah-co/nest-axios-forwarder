import { CallHandler, ExecutionContext, Logger } from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';
import { HttpLoggingInterceptor } from './http-logging.interceptor';

describe('Forwarder HTTP logging confidentiality', () => {
  afterEach(() => jest.restoreAllMocks());
  it('logs progress without request URLs, headers, payloads or exception stacks', async () => {
    const fixtureSecret = 'fake-private-request-and-exception-marker';
    const log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => {});
    const errorLog = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});
    const context = {
      switchToHttp: () => ({
        getRequest: () => ({
          url: `/forwarder/exec?token=${fixtureSecret}`,
          headers: { authorization: fixtureSecret },
          body: fixtureSecret,
        }),
      }),
    } as unknown as ExecutionContext;
    const interceptor = new HttpLoggingInterceptor();
    await lastValueFrom(
      interceptor.intercept(context, {
        handle: () => of({ ok: true }),
      } as CallHandler),
    );
    await expect(
      lastValueFrom(
        interceptor.intercept(context, {
          handle: () => throwError(() => new Error(fixtureSecret)),
        } as CallHandler),
      ),
    ).rejects.toThrow(fixtureSecret);
    expect(log).toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalled();
    expect(
      JSON.stringify([...log.mock.calls, ...errorLog.mock.calls]),
    ).not.toContain(fixtureSecret);
    expect(errorLog.mock.calls.every((args) => args.length === 1)).toBe(true);
  });
});
