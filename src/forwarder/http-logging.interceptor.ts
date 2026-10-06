import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';

@Injectable()
export class HttpLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(HttpLoggingInterceptor.name);

  intercept(_ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    this.logger.log('Incoming forwarding request');
    const start = Date.now();
    return next.handle().pipe(
      tap({
        next: () =>
          this.logger.log(
            `Forwarding request completed in ${Date.now() - start}ms`,
          ),
        error: () =>
          this.logger.error(
            `Forwarding request failed in ${Date.now() - start}ms`,
          ),
      }),
    );
  }
}
