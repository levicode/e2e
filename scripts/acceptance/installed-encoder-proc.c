/* Acceptance-only macOS owned-chain snapshot. No environment parsing or global scan. */
#ifdef __APPLE__
#include <libproc.h>
#include <sys/proc_info.h>
#include <sys/proc.h>
#include <regex.h>
#include <sys/sysctl.h>
#include <sys/types.h>
#include <unistd.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <errno.h>

#define MAX_CHILDREN 1024
#define MAX_ARGS 64
#define MAX_BUFFER 65536
struct snapshot { pid_t pid; struct proc_bsdinfo info; pid_t session; char exe[PROC_PIDPATHINFO_MAXSIZE]; };
struct arguments { int argc; char *argv[MAX_ARGS]; char *raw; size_t capacity; };
static void wipe(void *ptr, size_t n) { volatile unsigned char *p = ptr; while (n--) *p++ = 0; }
static void release(struct arguments *a) { if (a->raw) { wipe(a->raw, a->capacity); free(a->raw); } memset(a, 0, sizeof(*a)); }
static int snapshot(pid_t pid, struct snapshot *s) {
    memset(s, 0, sizeof(*s)); s->pid = pid;
    if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &s->info, sizeof(s->info)) != (int)sizeof(s->info)) return 0;
    if (s->info.pbi_uid != getuid()) return 0;
    char path[PROC_PIDPATHINFO_MAXSIZE];
    if (proc_pidpath(pid, path, sizeof(path)) <= 0 || !realpath(path, s->exe)) return 0;
    s->session = getsid(pid); return s->session >= 0;
}
static int same(const struct snapshot *a, const struct snapshot *b) {
    return a->pid == b->pid && a->info.pbi_ppid == b->info.pbi_ppid && a->info.pbi_uid == b->info.pbi_uid &&
        a->info.pbi_start_tvsec == b->info.pbi_start_tvsec && a->info.pbi_start_tvusec == b->info.pbi_start_tvusec &&
        a->info.pbi_pgid == b->info.pbi_pgid && a->session == b->session && !strcmp(a->exe, b->exe);
}
static int children(const struct snapshot *parent, pid_t *pids) {
    struct snapshot before, after;
    if (!snapshot(parent->pid, &before) || !same(parent, &before)) return -1;
    /* Capacity+1 detects truncation; never enumerate all system pids. */
    errno = 0;
    /* libproc returns PID COUNT, while the buffer-size argument is bytes. */
    int count = proc_listchildpids(parent->pid, pids, (int)(sizeof(pid_t) * (MAX_CHILDREN + 1)));
    int list_error = errno;
    /* A full spare-slot buffer cannot prove completeness. Errors may map to 0. */
    if (count < 0 || count > MAX_CHILDREN || list_error != 0) return -1;
    if (!snapshot(parent->pid, &after) || !same(parent, &after)) return -1;
    return count;
}
static int native_child(const struct snapshot *parent, const char *native, struct snapshot *found) {
    pid_t pids[MAX_CHILDREN + 1]; int n = children(parent, pids), count = 0;
    if (n < 0) return 0;
    for (int i = 0; i < n; i++) {
        struct snapshot child;
        if (!snapshot(pids[i], &child)) return 0;
        if (child.info.pbi_ppid != (uint32_t)parent->pid) return 0;
        if (!strcmp(child.exe, native)) { *found = child; count++; }
    }
    return count == 1;
}
static int next_string(char *buf, size_t size, size_t *at, char **out) {
    if (*at >= size) return 0;
    char *end = memchr(buf + *at, 0, size - *at);
    if (!end || end - (buf + *at) > 4096) return 0;
    *out = buf + *at; *at = (size_t)(end - buf) + 1; return 1;
}
static int parse_arguments(struct arguments *a, size_t size) {
    if (size < sizeof(int) || size > a->capacity) return 0;
    memcpy(&a->argc, a->raw, sizeof(int));
    if (a->argc < 1 || a->argc > MAX_ARGS) return 0;
    size_t at = sizeof(int); char *executable;
    if (!next_string(a->raw, size, &at, &executable)) return 0;
    /* Skip padding before argv[0], then parse exactly argc strings. Never touch env. */
    while (at < size && a->raw[at] == 0) at++;
    for (int i = 0; i < a->argc; i++) if (!next_string(a->raw, size, &at, &a->argv[i]) || !a->argv[i][0]) return 0;
    return 1;
}
static int read_arguments(const struct snapshot *owner, const struct snapshot *selected, struct arguments *a) {
    struct snapshot before, after, parent;
    if (!snapshot(owner->pid, &parent) || !same(owner, &parent) || !snapshot(selected->pid, &before) || !same(selected, &before)) return 0;
    if (before.info.pbi_ppid != (uint32_t)owner->pid || before.info.pbi_uid != owner->info.pbi_uid) return 0;
    a->capacity = MAX_BUFFER; a->raw = calloc(1, a->capacity); if (!a->raw) return 0;
    int mib[3] = { CTL_KERN, KERN_PROCARGS2, selected->pid }; size_t size = a->capacity;
    if (sysctl(mib, 3, a->raw, &size, NULL, 0) != 0 || size < sizeof(int) || size >= a->capacity) goto fail;
    if (!parse_arguments(a, size)) goto fail;
    if (!snapshot(selected->pid, &after) || !same(selected, &after) || !snapshot(owner->pid, &parent) || !same(owner, &parent)) goto fail;
    return 1;
fail: release(a); return 0;
}
static int number(const char *s, int decimal) {
    int dots = 0, digits = 0; if (!*s) return 0;
    for (; *s; s++) { if (isdigit((unsigned char)*s)) digits++; else if (decimal && *s == '.' && !dots++) {} else return 0; }
    return digits > 0;
}
static int safe_output(const char *s) {
    if (s[0] != '/' || strstr(s, "/../") || strstr(s, "/./")) return 0;
    const char *leaf = strrchr(s, '/'); if (!leaf || strcmp(leaf, "/video.webm")) return 0;
    const char *dir = leaf; while (dir > s && dir[-1] != '/') dir--;
    /* dir currently points at filename; find preceding directory. */
    dir = leaf - 1; while (dir > s && dir[-1] != '/') dir--;
    if (leaf - dir != 57 || strncmp(dir, "agent-browser-action-", 21)) return 0;
    for (int i = 0; i < 36; i++) { char c = dir[21+i]; if (i == 8 || i == 13 || i == 18 || i == 23) { if (c != '-') return 0; } else if (!isxdigit((unsigned char)c)) return 0; }
    for (const char *p = s; *p; p++) if ((unsigned char)*p < 32) return 0;
    return 1;
}
static int allowed(struct arguments *a) {
    if (a->argc == 2 && !strcmp(a->argv[1], "-version")) return 1;
    if (a->argc != 38 && a->argc != 40) return 0;
    const char *prefix[] = {"-y","-hide_banner","-loglevel","error","-fpsprobesize","0","-probesize","32","-analyzeduration","0","-f","image2pipe","-c:v"};
    for (int i=0;i<13;i++) if (strcmp(a->argv[i+1], prefix[i])) return 0;
    if (strcmp(a->argv[14],"ppm") && strcmp(a->argv[14],"png") && strcmp(a->argv[14],"mjpeg")) return 0;
    if (strcmp(a->argv[15],"-framerate") || !number(a->argv[16],1) || strcmp(a->argv[17],"-i") || strcmp(a->argv[18],"pipe:0") || strcmp(a->argv[19],"-vf")) return 0;
    regex_t filter;
    const char *pattern = "^(pad=ceil\\(iw/2\\)\\*2:ceil\\(ih/2\\)\\*2|scale=[1-9][0-9]*:[1-9][0-9]*:force_original_aspect_ratio=decrease,pad=ceil\\([1-9][0-9]*/2\\)\\*2:ceil\\([1-9][0-9]*/2\\)\\*2:0:0)$";
    if(regcomp(&filter,pattern,REG_EXTENDED|REG_NOSUB)) return 0;
    int valid_filter = strlen(a->argv[20])<=256 && regexec(&filter,a->argv[20],0,NULL,0)==0;
    regfree(&filter); if(!valid_filter) return 0;
    const char *middle[]={"-fps_mode","vfr","-c:v","libvpx","-crf","18","-b:v","8000k","-deadline","realtime","-cpu-used","4"};
    for(int i=0;i<12;i++) if(strcmp(a->argv[21+i],middle[i])) return 0;
    int at=33; if(a->argc==40) { if(strcmp(a->argv[at++],"-fs") || !number(a->argv[at++],0)) return 0; }
    if(strcmp(a->argv[at++],"-pix_fmt") || strcmp(a->argv[at++],"yuv420p") || strcmp(a->argv[at++],"-threads")) return 0;
    if(strcmp(a->argv[at],"1") && strcmp(a->argv[at],"4")) return 0;
    return safe_output(a->argv[at+1]);
}
static void quote(const char *s) {
    putchar('"'); for(;*s;s++) { unsigned char c=(unsigned char)*s; if(c=='"'||c=='\\') {putchar('\\');putchar(c);} else if(c<32) printf("\\u%04x",c); else putchar(c); } putchar('"');
}
static void emit(const struct snapshot *s) {
    printf("{\"pid\":%d,\"ppid\":%u,\"uid\":%u,\"start\":\"%llu.%llu\",\"group\":%u,\"session\":%d,\"state\":\"%s\",\"exe\":",s->pid,s->info.pbi_ppid,s->info.pbi_uid,(unsigned long long)s->info.pbi_start_tvsec,(unsigned long long)s->info.pbi_start_tvusec,s->info.pbi_pgid,s->session,s->info.pbi_status==SZOMB?"Z":"live"); quote(s->exe);
}
int main(int argc, char **argv) {
    int code=1; struct arguments args[8]; memset(args,0,sizeof(args));
    struct snapshot fixture, sampler, proxy, daemon, selected[8]; int selected_count=0;
    if(argc!=4 && argc!=6) goto done;
    char *end; long value=strtol(argv[1],&end,10); if(*end || value<=1 || value>INT_MAX) goto done;
    if(!snapshot(getppid(),&sampler) || sampler.info.pbi_ppid!=(uint32_t)value || !snapshot((pid_t)value,&fixture)) goto done;
    if(!native_child(&fixture,argv[2],&proxy) || !native_child(&proxy,argv[2],&daemon)) goto done;
    pid_t pids[MAX_CHILDREN+1]; int n=children(&daemon,pids); if(n<0) goto done;
    for(int i=0;i<n;i++) { struct snapshot child; if(!snapshot(pids[i],&child)) goto done;
        if(child.info.pbi_ppid!=(uint32_t)daemon.pid) goto done;
        if(strcmp(child.exe,argv[3])) continue;
        if(selected_count>=8) goto done;
        selected[selected_count]=child;
        if(!read_arguments(&daemon,&child,&args[selected_count]) || !allowed(&args[selected_count])) goto done;
        selected_count++;
    }
    struct snapshot again; if(!snapshot(fixture.pid,&again)||!same(&fixture,&again)||!snapshot(proxy.pid,&again)||!same(&proxy,&again)||!snapshot(daemon.pid,&again)||!same(&daemon,&again)) goto done;
    const char *tracked = "none";
    if(argc==6) {
        char *tail; long pid=strtol(argv[4],&tail,10); if(*tail || pid<=1 || pid>INT_MAX) goto done;
        struct snapshot current; struct proc_bsdinfo existence; errno=0;
        int exists=proc_pidinfo((pid_t)pid,PROC_PIDTBSDINFO,0,&existence,sizeof(existence));
        if(exists==0) { if(errno!=ESRCH) goto done; tracked="gone"; }
        else {
            if(exists!=(int)sizeof(existence) || !snapshot((pid_t)pid,&current)) goto done;
            char start[64]; snprintf(start,sizeof(start),"%llu.%llu",(unsigned long long)current.info.pbi_start_tvsec,(unsigned long long)current.info.pbi_start_tvusec);
            if(current.info.pbi_ppid!=(uint32_t)daemon.pid || strcmp(current.exe,argv[3]) || strcmp(start,argv[5])) goto done;
            tracked=current.info.pbi_status==SZOMB?"zombie":"live";
        }
    }
    printf("{\"tracked\":");quote(tracked);printf(",\"fixture\":");emit(&fixture);printf("},\"proxy\":");emit(&proxy);printf("},\"daemon\":");emit(&daemon);printf("},\"encoders\":[");
    for(int i=0;i<selected_count;i++) {if(i)putchar(',');emit(&selected[i]);printf(",\"argv\":[");
        /* argv[0] is canonical observed exe, never arbitrary process-supplied text. */
        quote(selected[i].exe); for(int j=1;j<args[i].argc;j++){putchar(',');quote(args[i].argv[j]);} printf("]}"); }
    printf("]}\n");code=0;
done:
    for(int i=0;i<8;i++)release(&args[i]);
    if(code) fputs("owned-snapshot-failed\n",stderr);
    return code;
}
#else
#error "This acceptance helper is compiled only on an authorized macOS runner."
#endif
