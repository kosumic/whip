// macOS host counters for arm64 iOS Simulator processes. No root or task port.
#include <libproc.h>
#include <mach/mach_time.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc_info.h>
#include <sys/resource.h>
#include <time.h>
#include <unistd.h>

static unsigned long long cpu_ns(struct rusage_info_v4 *usage, mach_timebase_info_data_t *timebase) {
    return (unsigned long long)(((__uint128_t)usage->ri_user_time + usage->ri_system_time) * timebase->numer / timebase->denom);
}

static int self_test(void) {
    mach_timebase_info_data_t timebase;
    mach_timebase_info(&timebase);
    struct rusage_info_v4 before = {0}, after = {0};
    struct timespec start, end;
    uint64_t thread_ids[16] = {0};
    if (proc_pidinfo(getpid(), PROC_PIDLISTTHREADS, 0, thread_ids, sizeof(thread_ids)) < sizeof(uint64_t)) return 2;
    uint64_t thread_id = thread_ids[0];
    struct proc_threadinfo thread_before = {0}, thread_after = {0};
    proc_pidinfo(getpid(), PROC_PIDTHREADINFO, thread_id, &thread_before, sizeof(thread_before));
    proc_pid_rusage(getpid(), RUSAGE_INFO_V4, (rusage_info_t *)&before);
    clock_gettime(CLOCK_PROCESS_CPUTIME_ID, &start);
    volatile unsigned long long checksum = 0;
    for (unsigned long long i = 0; i < 30000000; i++) checksum += i;
    clock_gettime(CLOCK_PROCESS_CPUTIME_ID, &end);
    proc_pid_rusage(getpid(), RUSAGE_INFO_V4, (rusage_info_t *)&after);
    proc_pidinfo(getpid(), PROC_PIDTHREADINFO, thread_id, &thread_after, sizeof(thread_after));
    double expected = (end.tv_sec - start.tv_sec) * 1e9 + end.tv_nsec - start.tv_nsec;
    double process = cpu_ns(&after, &timebase) - cpu_ns(&before, &timebase);
    double thread = (thread_after.pth_user_time + thread_after.pth_system_time) - (thread_before.pth_user_time + thread_before.pth_system_time);
    printf("{\"clockCpuNs\":%.0f,\"processCpuNs\":%.0f,\"threadCpuNs\":%.0f,\"timebaseNumer\":%u,\"timebaseDenom\":%u}\n", expected, process, thread, timebase.numer, timebase.denom);
    return process / expected < 0.95 || process / expected > 1.05 || thread / expected < 0.95 || thread / expected > 1.05;
}

int main(int argc, char **argv) {
    if (argc == 2 && !strcmp(argv[1], "self-test")) return self_test();
    if (argc != 4) return 2;
    pid_t app = atoi(argv[1]), server = atoi(argv[2]), simulator = atoi(argv[3]);
    mach_timebase_info_data_t timebase;
    mach_timebase_info(&timebase);
    int pids[16384];
    int count = proc_listallpids(pids, sizeof(pids));
    printf("{\"machTicks\":%llu,\"timebaseNumer\":%u,\"timebaseDenom\":%u,\"processes\":[", mach_absolute_time(), timebase.numer, timebase.denom);
    int emitted = 0;
    for (int i = 0; i < count; i++) {
        pid_t pid = pids[i];
        char path[PROC_PIDPATHINFO_MAXSIZE] = {0};
        if (proc_pidpath(pid, path, sizeof(path)) <= 0) continue;
        struct proc_bsdinfo bsd = {0};
        proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &bsd, sizeof(bsd));
        int webkit = bsd.pbi_ppid == simulator && strstr(path, "com.apple.WebKit.");
        if (pid != app && pid != server && !webkit) continue;
        struct rusage_info_v4 usage = {0};
        if (proc_pid_rusage(pid, RUSAGE_INFO_V4, (rusage_info_t *)&usage) != 0) continue;
        const char *kind = pid == app ? "app" : pid == server ? "herdr" : "webkit";
        printf("%s{\"pid\":%d,\"kind\":\"%s\",\"name\":\"%s\",\"cpuNs\":%llu,\"footprint\":%llu,\"rss\":%llu,\"startTicks\":%llu,\"threads\":[",
               emitted++ ? "," : "", pid, kind, strrchr(path, '/') + 1,
               cpu_ns(&usage, &timebase), usage.ri_phys_footprint, usage.ri_resident_size, usage.ri_proc_start_abstime);
        uint64_t threads[4096];
        int bytes = proc_pidinfo(pid, PROC_PIDLISTTHREADS, 0, threads, sizeof(threads));
        int thread_emitted = 0;
        for (int j = 0; j < bytes / (int)sizeof(uint64_t); j++) {
            struct proc_threadinfo thread = {0};
            if (proc_pidinfo(pid, PROC_PIDTHREADINFO, threads[j], &thread, sizeof(thread)) != sizeof(thread)) continue;
            // Names returned by this API are short OS thread names; escape JSON.
            char name[2 * sizeof(thread.pth_name) + 1];
            int n = 0;
            for (int k = 0; k < sizeof(thread.pth_name) && thread.pth_name[k]; k++) {
                unsigned char c = thread.pth_name[k];
                if (c < 32) continue;
                if (c == '"' || c == '\\') name[n++] = '\\';
                name[n++] = c;
            }
            name[n] = 0;
            printf("%s{\"id\":%llu,\"name\":\"%s\",\"cpuNs\":%llu}",
                   thread_emitted++ ? "," : "", threads[j], name, thread.pth_user_time + thread.pth_system_time);
        }
        printf("]}");
    }
    puts("]}");
    return 0;
}
