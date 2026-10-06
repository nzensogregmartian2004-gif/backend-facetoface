import nodemailer from 'nodemailer';
import { env, isProd } from '../config/env';

export type Mail = { to: string; subject: string; text: string };
export interface Mailer { send(mail: Mail): Promise<void> }

/** Boîte d'envoi en mémoire, utilisée uniquement par les tests. */
export const testOutbox: Mail[] = [];

class SmtpMailer implements Mailer {
  private transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  });
  async send(mail: Mail) {
    await this.transport.sendMail({ from: env.MAIL_FROM, ...mail });
  }
}

class ConsoleMailer implements Mailer {
  async send(mail: Mail) {
    if (env.NODE_ENV === 'test') { testOutbox.push(mail); return; }
    if (isProd) { console.warn(`[mail] SMTP non configuré : e-mail "${mail.subject}" non envoyé.`); return; }
    console.log(`\n[mail:dev] À: ${mail.to}\nObjet: ${mail.subject}\n${mail.text}\n`);
  }
}

export const mailer: Mailer = env.SMTP_HOST ? new SmtpMailer() : new ConsoleMailer();
export const mailerConfigured = Boolean(env.SMTP_HOST);
