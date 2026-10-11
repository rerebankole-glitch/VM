/* Tiny 64-bit long-mode demo for v86_64.
 *
 * SeaBIOS loads the first sector at 0x7C00. That sector reads the rest of
 * the image and jumps to stage2, which enters long mode and prints a
 * serial/VGA banner. This is not Linux and not Firefox — it only proves
 * the emulated CPU can run 64-bit code.
 */
        .code16
        .global _start
_start:
        cli
        xor     %ax, %ax
        mov     %ax, %ds
        mov     %ax, %es
        mov     %ax, %ss
        mov     $0x7C00, %sp
        cld

        /* Read 16 sectors starting at sector 2 into 0x7E00 (drive in DL). */
        mov     $0x02, %ah
        mov     $16, %al
        mov     $0, %ch
        mov     $2, %cl
        mov     $0, %dh
        mov     $0x7E00, %bx
        int     $0x13
        jc      .read_fail
        jmp     stage2

.read_fail:
        mov     $0x3F8, %dx
        mov     $'E', %al
        out     %al, %dx
.hang0:
        hlt
        jmp     .hang0

        /* Pad to the boot signature. */
        .space  510 - (. - _start)
        .word   0xAA55

stage2:
        cli
        /* Fast A20 */
        in      $0x92, %al
        or      $2, %al
        out     %al, $0x92

        lgdt    gdtr
        mov     %cr0, %eax
        or      $1, %eax
        mov     %eax, %cr0
        ljmp    $0x08, $pmode

        .code32
pmode:
        mov     $0x10, %ax
        mov     %ax, %ds
        mov     %ax, %es
        mov     %ax, %ss
        mov     $0x90000, %esp

        /* Identity-map the first 16 MiB with 2 MiB pages.
         * PML4 @ 0x1000, PDPT @ 0x2000, PD @ 0x3000. */
        mov     $0x1000, %edi
        xor     %eax, %eax
        mov     $0x1000, %ecx          /* 0x4000 bytes */
        rep     stosl

        movl    $0x2003, 0x1000        /* PML4[0] -> PDPT */
        movl    $0x3003, 0x2000        /* PDPT[0] -> PD */

        mov     $0x3000, %edi
        mov     $0x83, %eax            /* P|RW|PS */
        mov     $8, %ecx
.fill_pd:
        mov     %eax, (%edi)
        add     $0x200000, %eax
        add     $8, %edi
        loop    .fill_pd

        mov     $0x1000, %eax
        mov     %eax, %cr3
        mov     %cr4, %eax
        or      $0x20, %eax            /* PAE */
        mov     %eax, %cr4
        mov     $0xC0000080, %ecx      /* IA32_EFER */
        rdmsr
        or      $0x100, %eax           /* LME */
        wrmsr
        mov     %cr0, %eax
        or      $0x80000000, %eax      /* PG */
        mov     %eax, %cr0
        ljmp    $0x18, $lmode

        .code64
lmode:
        mov     $0x10, %ax
        mov     %ax, %ds
        mov     %ax, %es
        mov     %ax, %ss
        mov     $0x90000, %rsp

        /* VGA text: white-on-blue banner. */
        mov     $0xB8000, %rdi
        mov     $1000, %rcx
        mov     $0x1F201F20, %eax
        rep     stosl
        mov     $0xB8000, %rdi
        lea     banner(%rip), %rsi
.vga:
        lodsb
        test    %al, %al
        jz      .vga_done
        mov     $0x1F, %ah
        stosw
        jmp     .vga
.vga_done:

        /* Serial 115200 8N1 on COM1, then the ready token. */
        mov     $0x3F9, %dx
        xor     %al, %al
        out     %al, %dx                /* IER */
        mov     $0x3FB, %dx
        mov     $0x80, %al
        out     %al, %dx                /* DLAB */
        mov     $0x3F8, %dx
        mov     $1, %al
        out     %al, %dx                /* baud 115200 */
        inc     %dx
        xor     %al, %al
        out     %al, %dx
        mov     $0x3FB, %dx
        mov     $0x03, %al
        out     %al, %dx
        mov     $0x3FA, %dx
        mov     $0xC7, %al
        out     %al, %dx
        mov     $0x3FC, %dx
        mov     $0x0B, %al
        out     %al, %dx

        lea     ready(%rip), %rsi
.ser:
        lodsb
        test    %al, %al
        jz      .halt
        mov     $0x3F8, %dx
        out     %al, %dx
        jmp     .ser

.halt:
        hlt
        jmp     .halt

        .align  8
gdt:
        .quad   0
        .quad   0x00CF9A000000FFFF      /* 0x08: 32-bit code */
        .quad   0x00CF92000000FFFF      /* 0x10: data */
        .quad   0x00AF9A000000FFFF      /* 0x18: 64-bit code */
gdtr:
        .word   gdtr - gdt - 1
        .long   gdt

banner:
        .asciz  "WebVM 64-bit long mode. This is not Linux."
ready:
        .asciz  "WEBVM_X86_64_READY\n"
