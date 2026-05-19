import { config } from "./config.js";
import { logger } from "./logger.js";
import { redactSensitive } from "./redact.js";
import { readSecret } from "./secretStore.js";
import { parseJstDateAndTime, toJstParts } from "./time.js";
import type { ReservationOutcome, SpohabiReservation, WatchlistItem } from "./types.js";

interface SchoolInfo {
  id: number;
  slug: string;
  schema: string;
}

interface EventDateInfo {
  id: number;
  event_date: string;
  schedule: {
    id: number;
    start_time: string;
    end_time: string;
    max_people: number;
    lesson_id: number;
    lesson: {
      id: number;
      lesson_name: string;
      price: number | null;
    };
    schedule_levels?: Array<{ level_id?: number; level?: { id: number; level_name: string } }>;
  };
  reserve_event_dates: Array<{ id: number }>;
}

interface MemberInfo {
  id: number;
  last_name: string;
  first_name: string;
  member_account: {
    email: string;
    mobile_phone: string | null;
  } | null;
  school_members: Array<{ id: number; school_id: number; school_group_id: number | null; school?: { id: number; slug: string | null } | null }>;
}

interface TicketInfo {
  id: number;
  updated_at: string;
  expiration_date_from: string | null;
  expiration_date_to: string | null;
  member_ticket_set: {
    id: number;
    lesson_ids: number[] | null;
    level_ids: number[] | null;
    price_for_one: number | null;
    school_member_id: number;
    school_ticket_id: number;
    school_ticket: {
      name: string;
      type: number;
      numbers_of_time: number | null;
      numbers_of_ticket: number | null;
    };
    member_ticket_set_timeframes?: Array<{ day_of_week: number; start_time: string; end_time: string }>;
  };
  ticket_statuses: Array<{ status: number; reserve_event_date_id: number | null }>;
}

interface ReservationRow {
  id: number;
  status: number;
  event_date: {
    id: number;
    event_date: string;
    schedule: {
      id: number;
      lesson_id: number;
      start_time: string;
      end_time: string;
      lesson: {
        lesson_name: string;
      };
      schedule_coaches: Array<{ coach: { coach_name: string } }>;
      schedule_courts: Array<{ court: { court_name: string } }>;
      schedule_levels: Array<{ level: { level_name: string } }>;
    };
  };
  reserve: {
    id: number;
    school_member_id: number;
  };
}

const RESERVE_STATUS_PRESENT = 0;
const RESERVE_STATUS_UNDECIDED = 1;
const TICKET_TYPE_MONTHLY = 0;
const TICKET_STATUS_INUSE = 2;

interface SpohabiAuth {
  idToken: string;
}

export class SpohabiClient {
  private authPromise?: Promise<SpohabiAuth>;

  async reserveForWatch(item: WatchlistItem): Promise<ReservationOutcome> {
    const school = await this.resolveSchool(item.school_slug);
    const eventDate = await this.resolveEventDate(school.schema, item);
    if (!eventDate) return { status: "missed", reason: "event_date_not_found" };

    const currentReservations = eventDate.reserve_event_dates.length;
    if (currentReservations >= eventDate.schedule.max_people) {
      return { status: "missed", reason: "already_full", raw: { currentReservations, maxPeople: eventDate.schedule.max_people } };
    }

    const member = await this.findMemberByEmail(config.SPOHABI_EMAIL);
    if (!member) return { status: "blocked", reason: "member_not_found_by_email" };

    const schoolMember = member.school_members.find((m) => m.school_id === school.id);
    if (!schoolMember) return { status: "blocked", reason: "member_not_joined_school" };

    const memberHeaders = await this.memberHeaders(member.id);

    const sameTime = await this.hasSameTimeReservation(school.schema, schoolMember.id, eventDate, memberHeaders);
    if (sameTime) return { status: "blocked", reason: "same_time_reserved" };

    const tickets = await this.listUsableTickets(school.id, schoolMember.id, memberHeaders);
    const ticket = this.chooseTicket(tickets, item, eventDate);
    if (!ticket) return { status: "blocked", reason: "usable_ticket_not_found" };

    const payload = this.buildReservationPayload(school, member, schoolMember.id, eventDate, ticket);
    if (config.DRY_RUN) {
      logger.info({ payload: redactSensitive(payload) }, "DRY_RUN enabled; skipped Spohabi reservation API");
      return { status: "dry_run", reason: "dry_run", raw: redactSensitive(payload) };
    }
    const apiKey = await this.spohabiApiKey();
    if (!apiKey) {
      return { status: "blocked", reason: "spohabi_api_key_not_configured" };
    }

    const url = `${config.SPOHABI_RESERVE_API_BASE}/api/v1/reserve?schema=${encodeURIComponent(school.schema)}&slug=${encodeURIComponent(school.slug)}`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey
      },
      body: JSON.stringify(payload)
    });
    const raw = await response.json().catch(() => ({}));
    if (!response.ok) return { status: "failed", reason: `reserve_api_http_${response.status}`, raw };
    if (raw?.status !== "OK" && raw?.data?.status !== "OK") {
      return { status: "missed", reason: "reserve_api_not_ok", raw };
    }
    return { status: "reserved", reason: "reserved", raw };
  }

  async listCurrentReservations(input: { fromDate: string; toDate: string; schoolSlug?: string }): Promise<SpohabiReservation[]> {
    const member = await this.findMemberByEmail(config.SPOHABI_EMAIL);
    if (!member) throw new Error("Spohabi member not found");
    const schoolMembers = input.schoolSlug ? member.school_members.filter((item) => item.school?.slug === input.schoolSlug) : member.school_members;
    const rows: SpohabiReservation[] = [];
    for (const schoolMember of schoolMembers) {
      if (!schoolMember.school?.slug) continue;
      const school = await this.resolveSchool(schoolMember.school.slug);
      const headers = await this.memberHeaders(member.id);
      rows.push(...(await this.listReservationsForSchool(school, schoolMember.id, input.fromDate, input.toDate, headers)));
    }
    return rows.sort((a, b) => a.targetStartAt.localeCompare(b.targetStartAt));
  }

  private async resolveSchool(slug: string): Promise<SchoolInfo> {
    const data = await this.graphql<{ admin_school: SchoolInfo[] }>(
      `query School($slug: String!) {
        admin_school(where: {slug: {_eq: $slug}}, limit: 1) {
          id
          slug
          schema
        }
      }`,
      { slug }
    );
    const school = data.admin_school[0];
    if (!school) throw new Error(`Spohabi school not found: ${slug}`);
    return school;
  }

  private async listReservationsForSchool(
    school: SchoolInfo,
    schoolMemberId: number,
    fromDate: string,
    toDate: string,
    headers: Record<string, string>
  ): Promise<SpohabiReservation[]> {
    assertSchemaIdentifier(school.schema);
    const data = await this.graphql<Record<string, ReservationRow[]>>(
      `query Reservations {
        ${school.schema}_reserve_event_date(
          where: {
            status: {_in: [${RESERVE_STATUS_PRESENT}, ${RESERVE_STATUS_UNDECIDED}]},
            reserve: {school_member_id: {_eq: ${schoolMemberId}}},
            event_date: {
              event_date: {_gte: "${fromDate}", _lte: "${toDate}"}
            }
          },
          order_by: [{event_date: {event_date: asc}}, {reserve: {schedule: {start_time: asc}}}]
        ) {
          id
          status
          event_date {
            id
            event_date
            schedule {
              id
              lesson_id
              start_time
              end_time
              lesson {
                lesson_name
              }
              schedule_coaches {
                coach {
                  coach_name
                }
              }
              schedule_courts {
                court {
                  court_name
                }
              }
              schedule_levels {
                level {
                  level_name
                }
              }
            }
          }
          reserve {
            id
            school_member_id
          }
        }
      }`,
      undefined,
      headers
    );
    const schoolName = schoolDisplayName(school.slug);
    return (data[`${school.schema}_reserve_event_date`] ?? []).map((row) => {
      const schedule = row.event_date.schedule;
      return {
        id: String(row.reserve.id),
        reserveEventDateId: String(row.id),
        schoolName,
        lessonName: schedule.lesson.lesson_name,
        targetStartAt: parseJstDateAndTime(row.event_date.event_date, normalizeTime(schedule.start_time)).toISOString(),
        targetEndAt: parseJstDateAndTime(row.event_date.event_date, normalizeTime(schedule.end_time)).toISOString(),
        court: schedule.schedule_courts.map((item) => item.court.court_name).filter(Boolean).join("/") || null,
        coach: schedule.schedule_coaches.map((item) => item.coach.coach_name).filter(Boolean).join("/") || null,
        level: schedule.schedule_levels.map((item) => item.level.level_name).filter(Boolean).join("/") || null,
        lessonUrl: `https://spohabi.com/${school.slug}/lesson/${schedule.lesson_id}`
      };
    });
  }

  private async resolveEventDate(schema: string, item: WatchlistItem): Promise<EventDateInfo | null> {
    assertSchemaIdentifier(schema);
    const target = toJstParts(new Date(item.target_start_at));
    const eventDate = target.date.replace(/-/g, "/");
    const data = await this.graphql<Record<string, EventDateInfo[]>>(
      `query EventDate {
        ${schema}_event_date(
          where: {
            event_date: {_eq: "${eventDate}"},
            schedule: {lesson_id: {_eq: ${item.lesson_id}}}
          },
          order_by: {schedule: {start_time: asc}}
        ) {
          id
          event_date
          reserve_event_dates(where: {deleted_at: {_is_null: true}, status: {_in: [${RESERVE_STATUS_PRESENT}, ${RESERVE_STATUS_UNDECIDED}]}}) {
            id
          }
          schedule {
            id
            start_time
            end_time
            max_people
            lesson_id
            lesson {
              id
              lesson_name
              price
            }
            schedule_levels {
              level_id
              level {
                id
                level_name
              }
            }
          }
        }
      }`
    );
    const rows = data[`${schema}_event_date`] ?? [];
    return rows.find((row) => normalizeTime(row.schedule.start_time) === target.time) ?? null;
  }

  private async findMemberByEmail(email?: string): Promise<MemberInfo | null> {
    if (!email) throw new Error("SPOHABI_EMAIL is required");
    const data = await this.graphql<{ admin_member: MemberInfo[] }>(
      `query Member($email: String!) {
        admin_member(where: {member_account: {email: {_eq: $email}}, deleted_at: {_is_null: true}}, limit: 1) {
          id
          last_name
          first_name
          member_account {
            email
            mobile_phone
          }
          school_members {
            id
            school_id
            school_group_id
            school {
              id
              slug
            }
          }
        }
      }`,
      { email: email.toLowerCase() },
      await this.memberHeaders()
    );
    return data.admin_member[0] ?? null;
  }

  private async hasSameTimeReservation(
    schema: string,
    schoolMemberId: number,
    eventDate: EventDateInfo,
    headers: Record<string, string>
  ): Promise<boolean> {
    assertSchemaIdentifier(schema);
    const start = normalizeTime(eventDate.schedule.start_time);
    const data = await this.graphql<Record<string, Array<{ id: number }>>>(
      `query Reserve {
        ${schema}_reserve_event_date(where: {
          status: {_in: [${RESERVE_STATUS_PRESENT}, ${RESERVE_STATUS_UNDECIDED}]},
          deleted_at: {_is_null: true},
          reserve: {school_member_id: {_eq: ${schoolMemberId}}},
          event_date: {
            event_date: {_eq: "${eventDate.event_date}"},
            schedule: {start_time: {_eq: "${start}:00"}}
          }
        }) {
          id
        }
      }`,
      undefined,
      headers
    );
    return (data[`${schema}_reserve_event_date`] ?? []).length > 0;
  }

  private async listUsableTickets(schoolId: number, schoolMemberId: number, headers: Record<string, string>): Promise<TicketInfo[]> {
    const today = toJstParts(new Date()).date.replace(/-/g, "/");
    const data = await this.graphql<{ admin_member_ticket: TicketInfo[] }>(
      `query Tickets {
        admin_member_ticket(where: {
          member_ticket_set: {
            school_member_id: {_eq: ${schoolMemberId}},
            school_ticket: {school_id: {_eq: ${schoolId}}}
          },
          _or: [
            {expiration_date_to: {_gte: "${today}"}},
            {expiration_date_to: {_eq: ""}, expiration_date_from: {_eq: ""}},
            {expiration_date_to: {_is_null: true}, expiration_date_from: {_is_null: true}}
          ]
        }, order_by: {expiration_date_to: asc}) {
          id
          updated_at
          expiration_date_from
          expiration_date_to
          member_ticket_set {
            id
            lesson_ids
            level_ids
            price_for_one
            school_member_id
            school_ticket_id
            school_ticket {
              name
              type
              numbers_of_time
              numbers_of_ticket
            }
            member_ticket_set_timeframes {
              day_of_week
              start_time
              end_time
            }
          }
          ticket_statuses {
            status
            reserve_event_date_id
          }
        }
      }`,
      undefined,
      headers
    );
    return data.admin_member_ticket ?? [];
  }

  private chooseTicket(tickets: TicketInfo[], item: WatchlistItem, eventDate: EventDateInfo): TicketInfo | null {
    const priority = item.ticket_priority_json ? (JSON.parse(item.ticket_priority_json) as string[]) : [];
    const usable = tickets.filter((ticket) => this.isTicketUsable(ticket, item, eventDate));
    if (!usable.length) return null;
    if (!priority.length) return usable[0];
    return (
      [...usable].sort((a, b) => priorityIndex(priority, a.member_ticket_set.school_ticket.name) - priorityIndex(priority, b.member_ticket_set.school_ticket.name))[0] ??
      usable[0]
    );
  }

  private isTicketUsable(ticket: TicketInfo, item: WatchlistItem, eventDate: EventDateInfo): boolean {
    const set = ticket.member_ticket_set;
    if (set.lesson_ids && !set.lesson_ids.includes(item.lesson_id)) return false;
    const levelIds = eventDate.schedule.schedule_levels?.map((l) => l.level_id ?? l.level?.id).filter((id): id is number => typeof id === "number") ?? [];
    if (set.level_ids && levelIds.length && !levelIds.some((id) => set.level_ids?.includes(id))) return false;
    if (set.school_ticket.type === TICKET_TYPE_MONTHLY) {
      const used = ticket.ticket_statuses.filter((s) => s.status === TICKET_STATUS_INUSE).length;
      return used < (set.school_ticket.numbers_of_time ?? 1);
    }
    return ticket.ticket_statuses.length === 0;
  }

  private buildReservationPayload(school: SchoolInfo, member: MemberInfo, schoolMemberId: number, eventDate: EventDateInfo, ticket: TicketInfo): Record<string, unknown> {
    const lastName = config.SPOHABI_LAST_NAME || member.last_name;
    const firstName = config.SPOHABI_FIRST_NAME || member.first_name;
    return {
      schedule_id: eventDate.schedule.id,
      status: 0,
      last_name: lastName,
      first_name: firstName,
      email_address: config.SPOHABI_EMAIL || member.member_account?.email || "",
      tel: config.SPOHABI_TEL || member.member_account?.mobile_phone || "",
      survey_id: null,
      survey_data: [],
      member_note: config.SPOHABI_MEMBER_NOTE || "",
      slug: school.slug,
      start_first_date: eventDate.event_date,
      end_date: eventDate.event_date,
      school_member_id: schoolMemberId,
      price_difference: null,
      price_difference_status: 0,
      reservation_method: 1,
      event_date_id: eventDate.id,
      member_ticket_id: ticket.id,
      actionBy: `会員 (${lastName} ${firstName})`,
      postal_code: config.SPOHABI_POSTAL_CODE || "",
      prefecture: config.SPOHABI_PREFECTURE || "",
      city: config.SPOHABI_CITY || "",
      address_line1: config.SPOHABI_ADDRESS_LINE1 || "",
      address_line2: config.SPOHABI_ADDRESS_LINE2 || ""
    };
  }

  private async graphql<T>(query: string, variables?: Record<string, unknown>, headers?: Record<string, string>): Promise<T> {
    const response = await fetch(config.SPOHABI_GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hasura-role": "anonymous",
        ...headers
      },
      body: JSON.stringify({ query, variables })
    });
    const json = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (!response.ok || json.errors?.length || !json.data) {
      throw new Error(`Spohabi GraphQL failed: ${JSON.stringify(json.errors ?? response.status)}`);
    }
    return json.data;
  }

  private async spohabiApiKey(): Promise<string | undefined> {
    return config.SPOHABI_API_KEY || readSecret(config.SPOHABI_API_KEY_SECRET_NAME);
  }

  private async spohabiPassword(): Promise<string | undefined> {
    return config.SPOHABI_PASSWORD || readSecret(config.SPOHABI_PASSWORD_SECRET_NAME);
  }

  private async memberHeaders(memberId?: number): Promise<Record<string, string>> {
    const auth = await this.authenticate();
    return {
      authorization: `Bearer ${auth.idToken}`,
      "x-hasura-role": "member",
      ...(memberId ? { "x-hasura-member-id": String(memberId) } : {})
    };
  }

  private authenticate(): Promise<SpohabiAuth> {
    if (!this.authPromise) {
      this.authPromise = this.signIn();
    }
    return this.authPromise;
  }

  private async signIn(): Promise<SpohabiAuth> {
    if (!config.SPOHABI_EMAIL) throw new Error("SPOHABI_EMAIL is required");
    const [apiKey, password] = await Promise.all([this.spohabiApiKey(), this.spohabiPassword()]);
    if (!apiKey) throw new Error("SPOHABI_API_KEY or SPOHABI_API_KEY_SECRET_NAME is required");
    if (!password) throw new Error("SPOHABI_PASSWORD or SPOHABI_PASSWORD_SECRET_NAME is required");

    const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tenantId: config.SPOHABI_FIREBASE_TENANT_ID,
        email: config.SPOHABI_EMAIL.toLowerCase(),
        password: password.trim(),
        returnSecureToken: true
      })
    });
    const json = (await response.json()) as { idToken?: string; error?: { message?: string } };
    if (!response.ok || !json.idToken) {
      throw new Error(`Spohabi Firebase sign-in failed: ${json.error?.message ?? response.status}`);
    }
    return { idToken: json.idToken };
  }
}

function normalizeTime(value: string): string {
  const match = value.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return value;
  return `${match[1].padStart(2, "0")}:${match[2]}`;
}

function priorityIndex(priority: string[], name: string): number {
  const index = priority.findIndex((p) => name.includes(p));
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function assertSchemaIdentifier(schema: string): void {
  if (!/^[a-z0-9_]+$/.test(schema)) {
    throw new Error(`Unexpected Spohabi schema identifier: ${schema}`);
  }
}

function schoolDisplayName(slug: string): string {
  if (slug === "fc-tennis") return "ファーストシティテニスクラブ";
  return slug;
}
