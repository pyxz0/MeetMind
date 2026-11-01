import { Controller, Get } from '@nestjs/common';
import { RequirePermissions } from '../auth/auth.decorators';
import { PERMISSIONS } from '../auth/permissions';
import { JobRunService } from './job-run.service';

/**
 * 系统运维接口。
 *
 * 只暴露「任务是否健康」这类元信息，不带任何业务数据；
 * 因此用 system:read（管理员及以上）而不是更细的数据权限。
 */
@Controller('system')
export class SystemController {
  constructor(private readonly jobs: JobRunService) {}

  /** 后台任务概况：最后一次执行、近 24 小时次数与失败、是否可能卡住 */
  @Get('jobs')
  @RequirePermissions(PERMISSIONS.SYSTEM_READ)
  async jobsOverview() {
    return { jobs: await this.jobs.overview() };
  }
}
