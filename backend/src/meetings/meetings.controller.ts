import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common';
import { MeetingsService } from './meetings.service';
import type { CreateMeetingInput } from './meetings.service';

@Controller('meetings')
export class MeetingsController {
  constructor(private readonly meetingsService: MeetingsService) {}

  /** 校验前端传入的纪要结构，再交给业务服务进行关联保存。 */
  @Post()
  create(@Body() body: CreateMeetingInput) {
    if (!body || typeof body.content !== 'string' || !body.content.trim()) {
      throw new BadRequestException('content 不能为空');
    }
    if (body.summary != null && typeof body.summary !== 'string') {
      throw new BadRequestException('summary 必须是字符串');
    }
    if (
      body.decisions != null &&
      (!Array.isArray(body.decisions) ||
        body.decisions.some((item) => typeof item !== 'string'))
    ) {
      throw new BadRequestException('decisions 必须是字符串数组');
    }
    if (
      body.todos != null &&
      (!Array.isArray(body.todos) ||
        body.todos.some(
          (todo) =>
            !todo ||
            typeof todo.content !== 'string' ||
            (todo.assignee != null && typeof todo.assignee !== 'string') ||
            (todo.deadline != null && typeof todo.deadline !== 'string'),
        ))
    ) {
      throw new BadRequestException('todos 格式无效');
    }

    return this.meetingsService.create(body);
  }

  /** 获取所有历史会议，顺序和输出格式由业务服务统一处理。 */
  @Get()
  findAll() {
    return this.meetingsService.findAll();
  }

  /** 通过整数 ID 查询单条会议；ParseIntPipe 会拦截非数字路径参数。 */
  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.meetingsService.findOne(id);
  }

  /** 删除会议及其关联内容，并返回无响应体的 204 状态。 */
  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id', ParseIntPipe) id: number) {
    await this.meetingsService.remove(id);
  }
}
