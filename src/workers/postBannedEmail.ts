import { format } from 'date-fns';
import { messageToJson, Worker } from './worker';
import { Post, Source } from '../entity';
import { templateId } from './../common/mailing';
import {
  baseNotificationEmailData,
  sendEmail,
  truncatePostToTweet,
} from '../common';
import { fetchUser } from '../common';
import { PostReport } from '../entity/PostReport';
import { ChangeObject } from '../types';

interface Data {
  post: ChangeObject<Post>;
}

const reportReasons = new Map([
  ['BROKEN', 'Broken link'],
  ['NSFW', 'NSFW content'],
  ['CLICKBAIT', 'Clickbait'],
  ['LOW', 'Low quality content'],
  ['OTHER', 'Other reason'],
]);

const worker: Worker = {
  subscription: 'post-banned-email',
  handler: async (message, con, logger): Promise<void> => {
    const data: Data = messageToJson(message);
    const { post } = data;
    try {
      const reports = await con
        .getRepository(PostReport)
        .find({ postId: post.id });
      const reportsWithUser = await Promise.all(
        reports.map(async (report) => ({
          ...report,
          user: await fetchUser(report.userId),
        })),
      );
      if (reportsWithUser.length) {
        const source = await con.getRepository(Source).findOne(post.sourceId);
        await sendEmail({
          ...baseNotificationEmailData,
          templateId: templateId.postBanned,
          personalizations: reportsWithUser
            .filter(({ user }) => user?.email)
            .map(({ user, ...report }) => ({
              to: user.email,
              dynamicTemplateData: {
                first_name: user.name.split(' ')[0],
                timestamp: format(report.createdAt, 'PPppp'),
                report_type: reportReasons.get(report.reason),
                article_title: truncatePostToTweet(post),
                source_name: source.name,
                post_id: post.id,
              },
            })),
        });
        logger.info(
          {
            data,
            messageId: message.messageId,
          },
          'post banned or removed email sent',
        );
      }
    } catch (err) {
      logger.error(
        {
          data,
          messageId: message.messageId,
          err,
        },
        'failed to send post banned or removed email',
      );
      if (err.name === 'QueryFailedError') {
        return;
      }
      throw err;
    }
  },
};

export default worker;
