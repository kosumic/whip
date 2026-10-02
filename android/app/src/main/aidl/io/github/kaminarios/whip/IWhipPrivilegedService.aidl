package io.github.kaminarios.whip;

interface IWhipPrivilegedService {
    void destroy() = 16777114;
    boolean prepare(String requestId) = 1;
    String execute(String requestId, in String[] argv, int timeoutMs, int maxOutputBytes) = 2;
    void cancel(String requestId) = 3;
}
