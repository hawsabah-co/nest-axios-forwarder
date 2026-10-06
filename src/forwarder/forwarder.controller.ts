import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ExecRequestDto } from './dto/exec-request.dto';
import { IpWhitelistGuard } from './ip-whitelist.guard';
import { ForwarderService } from './forwarder.service';

@Controller('forwarder')
@UseGuards(IpWhitelistGuard)
export class ForwarderController {
  constructor(private readonly forwarderService: ForwarderService) {}

  @Post('exec')
  async execute(@Body() execRequestDto: ExecRequestDto): Promise<unknown> {
    return this.forwarderService.executeRequest(execRequestDto);
  }
}
