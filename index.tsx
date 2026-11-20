
import definePlugin, { IconComponent } from "@utils/types";
import { RenderModalProps } from "@vencord/discord-types";
import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import {
    SelectedChannelStore,
    VoiceStateStore,
    UserStore,
    FluxDispatcher,
    MediaEngineStore,
    Modal,
    openModal,
    useEffect,
    useState
} from "@webpack/common";

type VoiceMember = {
    id: string;
    username: string;
    displayName: string;
    isMe: boolean;
};

let refreshTimer: ReturnType<typeof setInterval> | undefined;
let badgeRefreshTimer: ReturnType<typeof setInterval> | undefined;
let badgeObserver: MutationObserver | undefined;

let latestMembers: VoiceMember[] = [];

// プラグインから操作したローカルミュート状態
const pluginMutedIds = new Set<string>();

const memberListeners = new Set<
    (members: VoiceMember[]) => void
>();

function publishMembers(members: VoiceMember[]) {
    latestMembers = members;

    for (const listener of memberListeners) {
        listener(members);
    }
}

function getVoiceMembers(): VoiceMember[] {
    const channelId = SelectedChannelStore.getVoiceChannelId();

    if (!channelId) return [];

    const voiceStates =
        VoiceStateStore.getVoiceStatesForChannel(channelId);

    const currentUserId = UserStore.getCurrentUser()?.id;

    return Object.values(voiceStates).map((state: any) => {
        const user = UserStore.getUser(state.userId);

        return {
            id: state.userId,
            username: user?.username ?? "Unknown",
            displayName:
                user?.globalName ??
                user?.username ??
                "Unknown",
            isMe: state.userId === currentUserId
        };
    });
}

function refresh() {
    publishMembers(getVoiceMembers());
    refreshLocalMuteBadges();
}

function handleVoiceStateUpdates() {
    console.log("[LocalMuteManager] Voice state updated");
    refresh();
}

/**
 * 通常のVC接続に対してローカルミュートを設定する。
 * streamコンテキストは対象外。
 */
function applyLocalMute(userId: string, muted: boolean): number {
    const engine = MediaEngineStore.getMediaEngine();
    let connectionCount = 0;

    engine.eachConnection(connection => {
        if (connection.destroyed) return;

        connection.setLocalMute(userId, muted);
        connectionCount++;
    }, "default");

    return connectionCount;
}

/**
 * LocalMuteManagerで操作した状態だけを取得する。
 */
function getLocalMuteState(userId: string): boolean {
    return pluginMutedIds.has(userId);
}

/**
 * React Fiberから参加者のユーザーIDを取得する。
 */
function getVoiceUserId(row: HTMLElement): string | null {
    const fiberKey = Object.keys(row).find(key =>
        key.startsWith("__reactFiber$")
    );

    if (!fiberKey) return null;

    let fiber: any = (row as any)[fiberKey];

    while (fiber) {
        if (
            fiber.elementType?.displayName === "ConnectedVoiceUser"
        ) {
            return fiber.memoizedProps?.user?.id ?? null;
        }

        fiber = fiber.return;
    }

    return null;
}

/**
 * VC参加者一覧にLocalMuteバッジを反映する。
 */

function refreshLocalMuteBadges() {
    if (typeof document === "undefined") return;

    const rows = document.querySelectorAll<HTMLElement>(
        '[class*="voiceUser"]'
    );

    rows.forEach(row => {
        const userId = getVoiceUserId(row);

        if (!userId) return;

        const container = row.querySelector<HTMLElement>(
            '[class*="usernameContainer"]'
        );

        if (!container) return;

        const nameElement = container.querySelector<HTMLElement>(
            '[class*="usernameFont"]'
        );

        if (!nameElement) return;

        const existingBadge = row.querySelector(
            '[data-lmm-badge="true"]'
        );

        if (pluginMutedIds.has(userId)) {
            if (existingBadge) {
                // 以前の位置にある場合も名前の横へ移動
                if (existingBadge.parentElement !== nameElement) {
                    nameElement.appendChild(existingBadge);
                }
                return;
            }

            const badge = document.createElement("span");

            badge.dataset.lmmBadge = "true";
            badge.textContent = "ミュート中";

            Object.assign(nameElement.style, {
                display: "inline-flex",
                alignItems: "center",
                gap: "6px"
            });

            Object.assign(badge.style, {
                display: "inline-block",
                flexShrink: "0",
                padding: "2px 5px",
                borderRadius: "4px",
                background: "#da3e44",
                color: "#f8f8f8",
                fontSize: "10px",
                fontWeight: "600",
                lineHeight: "14px",
                whiteSpace: "nowrap",
                verticalAlign: "middle",
                pointerEvents: "none"
            });

            nameElement.appendChild(badge);
        } else {
            existingBadge?.remove();
        }
    });
}


/**
 * Discordの画面更新を監視する。
 */
function startBadgeObserver() {
    if (typeof document === "undefined") return;

    stopBadgeObserver();

    refreshLocalMuteBadges();

    badgeObserver = new MutationObserver(() => {
        refreshLocalMuteBadges();
    });

    if (document.body) {
        badgeObserver.observe(document.body, {
            childList: true,
            subtree: true
        });
    }

    // MutationObserverの補助として定期的にも確認
    badgeRefreshTimer = setInterval(
        refreshLocalMuteBadges,
        2000
    );
}

function stopBadgeObserver() {
    badgeObserver?.disconnect();
    badgeObserver = undefined;

    if (badgeRefreshTimer) {
        clearInterval(badgeRefreshTimer);
        badgeRefreshTimer = undefined;
    }
}

/**
 * すべてのLocalMuteバッジを削除する。
 */
function removeAllLocalMuteBadges() {
    if (typeof document === "undefined") return;

    document.querySelectorAll('[data-lmm-badge="true"]')
        .forEach(badge => badge.remove());
}


function ParticipantsModal({
    rootProps
}: {
    rootProps: RenderModalProps;
}) {
    const [members, setMembers] = useState(latestMembers);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(
        () => new Set()
    );
    const [statusMessage, setStatusMessage] = useState("");
    const [statusType, setStatusType] = useState<"success" | "error" | "info">("info");

    useEffect(() => {
        const listener = (nextMembers: VoiceMember[]) => {
            setMembers(nextMembers);
        };

        memberListeners.add(listener);
        listener(latestMembers);

        return () => {
            memberListeners.delete(listener);
        };
    }, []);

    const selectableMembers = members.filter(
        member => !member.isMe
    );

    const selectedMembers = selectableMembers.filter(
        member => selectedIds.has(member.id)
    );

    const selectedCount = selectedMembers.length;

    const mutedCount = selectableMembers.filter(
        member => getLocalMuteState(member.id)
    ).length;

    function toggleMember(id: string) {
        setSelectedIds(previous => {
            const next = new Set(previous);

            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }

            return next;
        });

        setStatusMessage("");
    }

    function selectAll() {
        setSelectedIds(
            new Set(selectableMembers.map(member => member.id))
        );
        setStatusMessage("");
    }

    function clearSelection() {
        setSelectedIds(new Set());
        setStatusMessage("");
    }

    function handleMute(muted: boolean) {
        if (selectedCount === 0) return;

        let successCount = 0;
        let failedCount = 0;

        for (const target of selectedMembers) {
            try {
                const count = applyLocalMute(target.id, muted);

                if (count === 0) {
                    failedCount++;
                    continue;
                }

                if (muted) {
                    pluginMutedIds.add(target.id);
                } else {
                    pluginMutedIds.delete(target.id);
                }

                successCount++;
            } catch (error) {
                console.error(
                    "[LocalMuteManager] Failed to apply local mute",
                    target.id,
                    error
                );

                failedCount++;
            }
        }

        refreshLocalMuteBadges();
        setMembers(previous => [...previous]);

        if (failedCount === 0) {
            setStatusType("success");
            setStatusMessage(
                `${successCount}人の${muted ? "ローカルミュートを設定" : "ミュートを解除"}しました`
            );
        } else if (successCount > 0) {
            setStatusType("info");
            setStatusMessage(
                `${successCount}人成功、${failedCount}人失敗しました`
            );
        } else {
            setStatusType("error");
            setStatusMessage(
                "操作に失敗しました。通常VCの接続状態を確認してください"
            );
        }
    }

    const secondaryButtonStyle = {
        flex: 1,
        padding: "8px 12px",
        border: "none",
        borderRadius: "6px",
        background: "var(--button-secondary-background)",
        color: "var(--text-normal)",
        fontSize: "13px",
        fontWeight: 600,
        cursor: "pointer"
    } as const;

    const actionButtonStyle = {
        width: "100%",
        padding: "12px",
        border: "none",
        borderRadius: "8px",
        fontSize: "14px",
        fontWeight: 700,
        cursor: "pointer"
    } as const;

    return (
        <Modal {...rootProps} title="Local Mute Manager">
            <div style={{
                padding: "8px 0 4px",
                minWidth: "340px",
                maxWidth: "100%"
            }}>
                {/* 上部の人数カード */}
                <div style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: "10px",
                    marginBottom: "20px"
                }}>
                    <div style={{
                        padding: "14px",
                        borderRadius: "8px",
                        background: "var(--background-secondary)"
                    }}>
                        <div style={{
                            fontSize: "12px",
                            color: "var(--text-muted)",
                            marginBottom: "5px"
                        }}>
                            参加者
                        </div>
                        <div style={{
                            fontSize: "26px",
                            fontWeight: 700,
                            color: "var(--header-primary)"
                        }}>
                            {selectableMembers.length}
                            <span style={{
                                fontSize: "13px",
                                marginLeft: "4px",
                                fontWeight: 400
                            }}>
                                人
                            </span>
                        </div>
                    </div>

                    <div style={{
                        padding: "14px",
                        borderRadius: "8px",
                        background: "var(--background-secondary)"
                    }}>
                        <div style={{
                            fontSize: "12px",
                            color: "var(--text-muted)",
                            marginBottom: "5px"
                        }}>
                            選択中
                        </div>
                        <div style={{
                            fontSize: "26px",
                            fontWeight: 700,
                            color: "var(--header-primary)"
                        }}>
                            {selectedCount}
                            <span style={{
                                fontSize: "13px",
                                marginLeft: "4px",
                                fontWeight: 400
                            }}>
                                人
                            </span>
                        </div>
                    </div>
                </div>

                {/* 参加者一覧の見出し */}
                <div style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: "10px"
                }}>
                    <div style={{
                        fontSize: "14px",
                        fontWeight: 700,
                        color: "var(--header-primary)"
                    }}>
                        参加者一覧
                    </div>

                    <div style={{
                        fontSize: "11px",
                        color: "var(--text-muted)"
                    }}>
                        ミュート中 {mutedCount}人
                    </div>
                </div>

                {/* 全選択・選択解除 */}
                <div style={{
                    display: "flex",
                    gap: "8px",
                    marginBottom: "10px"
                }}>
                    <button
                        onClick={selectAll}
                        style={secondaryButtonStyle}
                    >
                        全選択
                    </button>

                    <button
                        onClick={clearSelection}
                        style={secondaryButtonStyle}
                    >
                        選択解除
                    </button>
                </div>

                {/* 参加者カード */}
                <div style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "6px",
                    maxHeight: "300px",
                    overflowY: "auto",
                    paddingRight: "2px"
                }}>
                    {selectableMembers.length === 0 ? (
                        <div style={{
                            padding: "28px 12px",
                            textAlign: "center",
                            color: "var(--text-muted)",
                            background: "var(--background-secondary)",
                            borderRadius: "8px",
                            fontSize: "13px"
                        }}>
                            VCに他の参加者がいません
                        </div>
                    ) : (
                        selectableMembers.map(member => {
                            const isSelected = selectedIds.has(member.id);
                            const isMuted = getLocalMuteState(member.id);

                            return (
                                <label
                                    key={member.id}
                                    style={{
                                        display: "flex",
                                        alignItems: "center",
                                        justifyContent: "space-between",
                                        gap: "10px",
                                        padding: "12px",
                                        borderRadius: "8px",
                                        border: isSelected
                                            ? "1px solid var(--brand-experiment)"
                                            : "1px solid var(--background-modifier-accent)",
                                        background: isSelected
                                            ? "var(--background-modifier-selected)"
                                            : "var(--background-secondary)",
                                        cursor: "pointer",
                                        transition: "background 0.12s ease"
                                    }}
                                >
                                    <div style={{
                                        display: "flex",
                                        alignItems: "center",
                                        gap: "10px",
                                        minWidth: 0
                                    }}>
                                        <input
                                            type="checkbox"
                                            checked={isSelected}
                                            onChange={() => toggleMember(member.id)}
                                            style={{
                                                width: "17px",
                                                height: "17px",
                                                flexShrink: 0,
                                                accentColor: "var(--brand-experiment)",
                                                cursor: "pointer"
                                            }}
                                        />

                                        <span style={{
                                            fontSize: "14px",
                                            fontWeight: 600,
                                            color: "var(--header-primary)",
                                            overflow: "hidden",
                                            textOverflow: "ellipsis",
                                            whiteSpace: "nowrap"
                                        }}>
                                            {member.displayName}
                                        </span>
                                    </div>

                                    <span style={{
                                        flexShrink: 0,
                                        padding: "3px 7px",
                                        borderRadius: "5px",
                                        fontSize: "10px",
                                        fontWeight: 700,
                                        color: isMuted ? "#f8f8f8" : "var(--text-muted)",
                                        background: isMuted
                                            ? "#da3e44"
                                            : "var(--background-modifier-accent)"
                                    }}>
                                        {isMuted ? "ミュート中" : ""}
                                    </span>
                                </label>
                            );
                        })
                    )}
                </div>

                {/* 操作結果メッセージ */}
                {statusMessage && (
                    <div style={{
                        marginTop: "12px",
                        padding: "10px 12px",
                        borderRadius: "7px",
                        fontSize: "12px",
                        fontWeight: 600,
                        color: statusType === "error"
                            ? "var(--status-danger)"
                            : statusType === "success"
                                ? "var(--status-positive)"
                                : "var(--text-normal)",
                        background: "var(--background-secondary)"
                    }}>
                        {statusMessage}
                    </div>
                )}

                {/* ミュート操作ボタン */}
                <div style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "8px",
                    marginTop: "16px",
                    paddingTop: "14px",
                    borderTop: "1px solid var(--background-modifier-accent)"
                }}>
                    <div style={{
                        fontSize: "12px",
                        color: "var(--text-muted)",
                        marginBottom: "2px"
                    }}>
                        選択した {selectedCount} 人に対して操作
                    </div>

                    <button
                        onClick={() => handleMute(true)}
                        disabled={selectedCount === 0}
                        style={{
                            ...actionButtonStyle,
                            background: selectedCount === 0
                                ? "#da3e43"
                                : "#da3e44",
                            color: "#f8f8f8",
                            opacity: selectedCount === 0 ? 0.5 : 1,
                            cursor: selectedCount === 0 ? "not-allowed" : "pointer"
                        }}
                    >
                        ローカルミュート
                    </button>

                    <button
                        onClick={() => handleMute(false)}
                        disabled={selectedCount === 0}
                        style={{
                            ...actionButtonStyle,
                            background: "#2c2f33",
                            color: "#f8f8f8",
                            opacity: selectedCount === 0 ? 0.5 : 1,
                            cursor: selectedCount === 0 ? "not-allowed" : "pointer"
                        }}
                    >
                        ミュート解除
                    </button>
                </div>
            </div>
        </Modal>
    );
}


const ParticipantIcon: IconComponent = ({
    height = 20,
    width = 20,
    className
}) => (
    <svg
        viewBox="0 0 24 24"
        height={height}
        width={width}
        className={className}
        fill="currentColor"
    >
        <path d="M16 11a4 4 0 1 0-3.87-5h2.1A2 2 0 1 1 16 9h-1v2h1Zm-8 0a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0-6a2 2 0 1 1 0 4 2 2 0 0 1 0-4Zm8 8c-1.2 0-2.3.2-3.2.6A6.9 6.9 0 0 1 14 17v2h8v-2c0-2.2-2.7-4-6-4ZM8 13c-3.3 0-6 1.8-6 4v3h12v-3c0-2.2-2.7-4-6-4Z" />
    </svg>
);

const ParticipantChatBarButton: ChatBarButtonFactory = ({
    isMainChat
}) => {
    if (!isMainChat) return null;

    return (
        <ChatBarButton
            tooltip="VC参加者一覧"
            onClick={() => {
                refresh();

                openModal(props => (
                    <ParticipantsModal rootProps={props} />
                ));
            }}
            buttonProps={{
                "aria-haspopup": "dialog"
            }}
        >
            <ParticipantIcon className="chat-button" />
        </ChatBarButton>
    );
};

export default definePlugin({
    name: "LocalMuteManager",

    description: "Manage local mutes for multiple voice chat users.",

    authors: [
        {
            name: "Personal Developer",
            id: 0n,
        },
    ],

    chatBarButton: {
        icon: ParticipantIcon,
        render: ParticipantChatBarButton
    },

    start() {
        console.log("[LocalMuteManager] Plugin started");

        FluxDispatcher.subscribe(
            "VOICE_STATE_UPDATES",
            handleVoiceStateUpdates
        );

        refresh();
        startBadgeObserver();

        refreshTimer = setInterval(refresh, 5000);
    },

    stop() {
        FluxDispatcher.unsubscribe(
            "VOICE_STATE_UPDATES",
            handleVoiceStateUpdates
        );

        if (refreshTimer) {
            clearInterval(refreshTimer);
            refreshTimer = undefined;
        }

        stopBadgeObserver();
        removeAllLocalMuteBadges();

        pluginMutedIds.clear();

        publishMembers([]);
        memberListeners.clear();

        console.log("[LocalMuteManager] Plugin stopped");
    }
});
