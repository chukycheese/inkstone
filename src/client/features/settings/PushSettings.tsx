import { useEffect, useRef, useState } from 'react';
import { BellRing } from 'lucide-react';
import { Button } from '../../components/primitives';
import { SettingRow, Switch } from '../../components/form';
import { api, ApiError } from '../../lib/api';
import { t } from "../../lib/i18n";
import { useUi } from '../../store/ui';

type PushUiState = 'loading' | 'on' | 'off' | 'unsupported' | 'unconfigured';

function pushSupported(): boolean {
    return typeof window !== 'undefined' &&
        'serviceWorker' in navigator &&
        'PushManager' in window &&
        'Notification' in window;
}

function applicationServerKey(publicKey: string): Uint8Array {
    const padded = publicKey.replace(/-/g, '+').replace(/_/g, '/');
    const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
    const bin = atob(padded + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

async function currentSubscription(): Promise<PushSubscription | null> {
    const registration = await navigator.serviceWorker.ready;
    return registration.pushManager.getSubscription();
}

/** CKCZ-27: per-device Web Push opt-in. Default off; state lives in the push service, not in user settings. */
export function PushSettings() {
    const toast = useUi((s) => s.toast);
    const [uiState, setUiState] = useState<PushUiState>('loading');
    const [busy, setBusy] = useState(false);
    const [testing, setTesting] = useState(false);
    const mountedRef = useRef(true);
    useEffect(() => {
        mountedRef.current = true;
        let cancelled = false;
        void (async () => {
            if (!pushSupported()) {
                if (!cancelled) setUiState('unsupported');
                return;
            }
            try {
                const { configured } = await api.push.vapidKey();
                if (cancelled) return;
                if (!configured) {
                    setUiState('unconfigured');
                    return;
                }
                const existing = await currentSubscription().catch(() => null);
                if (!cancelled) setUiState(existing ? 'on' : 'off');
            } catch {
                if (!cancelled) setUiState('off');
            }
        })();
        return () => {
            cancelled = true;
            mountedRef.current = false;
        };
    }, []);

    const fail = (error: unknown) => {
        const description = error instanceof ApiError ? error.message
            : error instanceof Error ? error.message : String(error);
        toast({ title: t("settings.push_failed"), description, tone: 'danger' });
    };

    const setEnabled = (next: boolean) => {
        void (async () => {
            if (busy) return;
            setBusy(true);
            try {
                if (next) {
                    const permission = await Notification.requestPermission();
                    if (permission !== 'granted') {
                        toast({ title: t("settings.push_permission_denied"), tone: 'warning' });
                        return;
                    }
                    const { configured, publicKey } = await api.push.vapidKey();
                    if (!configured || !publicKey) {
                        setUiState('unconfigured');
                        return;
                    }
                    const registration = await navigator.serviceWorker.ready;
                    const subscription = await registration.pushManager.subscribe({
                        userVisibleOnly: true,
                        applicationServerKey: applicationServerKey(publicKey) as BufferSource,
                    });
                    const raw = subscription.toJSON();
                    if (!raw.endpoint || !raw.keys?.p256dh || !raw.keys?.auth) throw new Error('subscription incomplete');
                    // toJSON keys are already base64url, matching the server format.
                    await api.push.subscribe({
                        endpoint: raw.endpoint,
                        keys: { p256dh: raw.keys.p256dh, auth: raw.keys.auth },
                    });
                    if (mountedRef.current) setUiState('on');
                } else {
                    const existing = await currentSubscription().catch(() => null);
                    if (existing?.endpoint) {
                        await api.push.unsubscribe(existing.endpoint).catch(() => ({ ok: true, removed: false }));
                        await existing.unsubscribe().catch(() => false);
                    }
                    if (mountedRef.current) setUiState('off');
                }
            } catch (error) {
                fail(error);
            } finally {
                if (mountedRef.current) setBusy(false);
            }
        })();
    };

    const sendTest = () => {
        void (async () => {
            setTesting(true);
            try {
                const result = await api.push.test();
                if (result.sent > 0) toast({ title: t("settings.push_test_sent"), tone: 'success' });
                else toast({ title: t("settings.push_test_no_subscription"), tone: 'warning' });
            } catch (error) {
                fail(error);
            } finally {
                if (mountedRef.current) setTesting(false);
            }
        })();
    };

    if (uiState === 'loading') return null;
    const note = uiState === 'unsupported' ? t("settings.push_not_supported")
        : uiState === 'unconfigured' ? t("settings.push_not_configured")
        : null;
    return (<section>
      <SettingRow title={t("settings.push_notifications")} description={note ?? t("settings.push_notifications_description")}>
        <Switch checked={uiState === 'on'} disabled={busy || uiState === 'unsupported' || uiState === 'unconfigured'} onChange={setEnabled} label={t("settings.push_notifications")}/>
      </SettingRow>
      {uiState === 'on' && (<div className="flex justify-end py-2">
        <Button size="sm" variant="secondary" icon={<BellRing size={12}/>} loading={testing} disabled={testing} onClick={sendTest}>{t("settings.push_send_test")}</Button>
      </div>)}
    </section>);
}
