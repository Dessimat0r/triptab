import { accountAuditStatement } from './audit';
import { canonicalJson } from './data-utils';
import { defaultLanguagePreferences, tripLanguagePreferencesSchema, type TripLanguagePreferences } from './receipt-languages';
import { RequestError } from './store';

export type LanguagePreferenceSnapshot={preferences:TripLanguagePreferences;revision:number};
export const accessibleTripSql='EXISTS (SELECT 1 FROM trips t WHERE t.id = ? AND (t.owner = ? OR EXISTS (SELECT 1 FROM memberships m WHERE m.trip_id = t.id AND m.user_id = ?)))';
const identitySql='NOT EXISTS (SELECT 1 FROM auth_links WHERE oai_user_id=? AND user_id<>?)';
export async function readTripLanguagePreferences(database:D1Database,userId:string,tripId:string):Promise<LanguagePreferenceSnapshot> {
  const row=await database.prepare(`SELECT p.data,p.revision FROM trips t
    LEFT JOIN trip_language_preferences p ON p.trip_id=t.id AND p.user_id=?
    WHERE t.id=? AND (t.owner=? OR EXISTS (SELECT 1 FROM memberships m WHERE m.trip_id=t.id AND m.user_id=?))`)
    .bind(userId,tripId,userId,userId).first<{data:string|null;revision:number|null}>();
  if(!row)throw new RequestError('Holiday not found in your account.',404);
  return {preferences:row.data?tripLanguagePreferencesSchema.parse(JSON.parse(row.data)):defaultLanguagePreferences(),revision:row.revision??0};
}
export async function saveTripLanguagePreferences(database:D1Database,profile:{id:string;displayName:string},tripId:string,revision:number,
  change:{readingLanguage?:TripLanguagePreferences['readingLanguage'];primaryVersion?:TripLanguagePreferences['primaryVersion'];itemKey?:string;itemVersion?:TripLanguagePreferences['primaryVersion']|null}):Promise<LanguagePreferenceSnapshot> {
  const previous=await readTripLanguagePreferences(database,profile.id,tripId);
  if(previous.revision!==revision)throw new RequestError('Your language preferences changed elsewhere. Refresh and try again.',409);
  const next={...previous.preferences,itemVersions:{...previous.preferences.itemVersions},
    ...(change.readingLanguage?{readingLanguage:change.readingLanguage}:{}),...(change.primaryVersion?{primaryVersion:change.primaryVersion}:{})};
  if(change.itemKey){if(change.itemVersion===null)delete next.itemVersions[change.itemKey];else if(change.itemVersion)next.itemVersions[change.itemKey]=change.itemVersion;}
  const checked=tripLanguagePreferencesSchema.parse(next),data=canonicalJson(checked);
  if(new TextEncoder().encode(data).byteLength>250_000)throw new RequestError('Too many saved item display choices. Use the holiday default for some items.',413);
  if(data===canonicalJson(previous.preferences))return previous;
  const before={readingLanguage:previous.preferences.readingLanguage,primaryVersion:previous.preferences.primaryVersion,
    ...(change.itemKey?{itemKey:change.itemKey,itemVersion:previous.preferences.itemVersions[change.itemKey]||'holiday-default'}:{})};
  const after={readingLanguage:checked.readingLanguage,primaryVersion:checked.primaryVersion,
    ...(change.itemKey?{itemKey:change.itemKey,itemVersion:checked.itemVersions[change.itemKey]||'holiday-default'}:{})};
  const result=await database.batch([
    revision===0
      ? database.prepare(`INSERT INTO trip_language_preferences(user_id,trip_id,data,revision)
        SELECT ?,?,?,1 WHERE ${accessibleTripSql} AND ${identitySql} ON CONFLICT(user_id,trip_id) DO NOTHING`)
        .bind(profile.id,tripId,data,tripId,profile.id,profile.id,profile.id,profile.id)
      : database.prepare(`UPDATE trip_language_preferences SET data=?,revision=revision+1
        WHERE user_id=? AND trip_id=? AND revision=? AND ${accessibleTripSql} AND ${identitySql}`)
        .bind(data,profile.id,tripId,revision,tripId,profile.id,profile.id,profile.id,profile.id),
    accountAuditStatement(database,{userId:profile.id,actorName:profile.displayName,entityType:'language',entityId:tripId,
      action:previous.revision?'update':'create',before,after},{sql:'changes()>0',bindings:[]}),
  ]);
  if(!result[0].meta.changes)throw new RequestError('Your preferences or holiday access changed. Refresh and try again.',409);
  return {preferences:checked,revision:revision+1};
}
