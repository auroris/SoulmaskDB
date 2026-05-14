"""Last check on lootbag theory: timestamps and orphan distribution."""
import sqlite3
import os
from collections import Counter

DB = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'world.db')


def shortcls(s):
    return s.split('.')[-1] if s and '.' in s else s


def main():
    conn = sqlite3.connect(DB)
    c = conn.cursor()

    # --- Timestamps: any rows much newer than the median? ---
    print('--- actor_time distribution ---')
    times = [t for t, in c.execute("SELECT actor_time FROM actor_table WHERE actor_time != '' AND actor_time IS NOT NULL")]
    print(f'{len(times):,} rows with actor_time')
    sample = sorted(set(times))
    if sample:
        print(f'  earliest: {sample[0]}')
        print(f'  latest:   {sample[-1]}')
        print(f'  distinct: {len(sample)}')
        # Show distribution: count by date-prefix (first 10 chars = YYYY-MM-DD if ISO)
        date_counts = Counter(t[:10] for t in times)
        print('  top 10 dates:')
        for d, n in date_counts.most_common(10):
            print(f'    {n:6d}  {d}')

    # --- Anything dated noticeably after the bulk of the world? ---
    # Median date, then count rows after the 99th percentile
    sorted_times = sorted(times)
    p50 = sorted_times[len(sorted_times) // 2]
    p99 = sorted_times[int(len(sorted_times) * 0.99)]
    print(f'\n  p50 actor_time: {p50}')
    print(f'  p99 actor_time: {p99}')

    # Look at rows above p99 — what classes?
    print('\n  classes of rows in top 1% by actor_time (could be recent activity):')
    recent_classes = Counter()
    for sc, t in c.execute("SELECT actor_script, actor_time FROM actor_table WHERE actor_time > ?", (p99,)):
        recent_classes[shortcls(sc) or '<empty>'] += 1
    for cls, n in recent_classes.most_common(20):
        print(f'    {n:5d}  {cls}')

    # --- Look at the orphan chests' BLOBS — do their bodies look like
    #     they reference an NPC class, suggesting "this WAS an NPC bag"? ---
    print('\n--- orphan BG_JianZhu_RongQi blobs: scan for NPC-shaped strings ---')
    NPC_MARKERS = [b'SandBandit', b'Savage', b'DesertWolf', b'Exiles',
                   b'PlayerBase', b'Scout_', b'TribeF_', b'TribeM_',
                   b'Monster_']
    orphan_chests = c.execute(
        "SELECT actor_serial, actor_script, actor_data FROM actor_table "
        "WHERE actor_script = '/Game/Blueprints/JianZhu/RongQi/BP_BGActor_JianZhu_RongQi.BP_BGActor_JianZhu_RongQi_C'"
    ).fetchall()
    serial_to_script = dict(c.execute("SELECT actor_serial, actor_script FROM actor_table"))
    OWNER_TOKENS = ('jianzhu/rongqi', 'jianzhu/gongzuotai', 'jianzhu/jiaju',
                    'jianzhu/zhongzhi', 'jianzhu/lighting', 'gongzuotai',
                    'jianzhu/fengche', 'jianzhu/chuansongmen', 'hplayerstate',
                    'monster', 'dongwu', 'npc/', '/conveyor', 'animalhouse',
                    'playerbase', '/ship/', 'tribeboat')
    is_owner = lambda x: any(t in (x or '').lower() for t in OWNER_TOKENS)
    found = 0
    nfound_any_npc = 0
    nfound_no_npc = 0
    for serial, sc, blob in orphan_chests:
        next_sc = serial_to_script.get(serial + 1, '')
        prev_sc = serial_to_script.get(serial - 1, '')
        if is_owner(next_sc) or is_owner(prev_sc):
            continue
        # This is an orphan chest BG. Does its blob mention any NPC class?
        hits = [m for m in NPC_MARKERS if m in blob]
        if hits:
            nfound_any_npc += 1
            if found < 8:
                print(f'  serial={serial} HAS NPC string in body: {[h.decode() for h in hits]}')
                found += 1
        else:
            nfound_no_npc += 1
    print(f'\n  orphan chest BGs total: {nfound_any_npc + nfound_no_npc}')
    print(f'  with NPC-class string in body: {nfound_any_npc}')
    print(f'  without:                        {nfound_no_npc}')


if __name__ == '__main__':
    main()
