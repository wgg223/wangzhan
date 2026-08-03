import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';

import '../config/app_config.dart';
import '../models/article.dart';
import '../utils/time_format.dart';

/// 文章卡片
class ArticleCard extends StatelessWidget {
  const ArticleCard({super.key, required this.article, this.onTap});

  final Article article;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (article.cover.isNotEmpty) ...[
                ClipRRect(
                  borderRadius: BorderRadius.circular(8),
                  child: CachedNetworkImage(
                    imageUrl: AppConfig.asset(article.cover),
                    width: 96,
                    height: 72,
                    fit: BoxFit.cover,
                    placeholder: (c, u) => Container(width: 96, height: 72, color: Colors.grey.shade200),
                    errorWidget: (c, u, e) => Container(width: 96, height: 72, color: Colors.grey.shade200, child: const Icon(Icons.image_outlined)),
                  ),
                ),
                const SizedBox(width: 12),
              ],
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      article.title,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
                    ),
                    const SizedBox(height: 6),
                    if (article.summary.isNotEmpty)
                      Text(
                        article.summary,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: 13, color: Colors.grey.shade600),
                      ),
                    const SizedBox(height: 8),
                    Row(
                      children: [
                        Text(article.authorName, style: TextStyle(fontSize: 12, color: Colors.grey.shade500)),
                        const SizedBox(width: 8),
                        Text(TimeFormat.from(article.createdAt), style: TextStyle(fontSize: 12, color: Colors.grey.shade500)),
                        const Spacer(),
                        Icon(Icons.visibility_outlined, size: 14, color: Colors.grey.shade500),
                        const SizedBox(width: 2),
                        Text('${article.viewCount}', style: TextStyle(fontSize: 12, color: Colors.grey.shade500)),
                        const SizedBox(width: 8),
                        Icon(Icons.thumb_up_outlined, size: 14, color: Colors.grey.shade500),
                        const SizedBox(width: 2),
                        Text('${article.likeCount}', style: TextStyle(fontSize: 12, color: Colors.grey.shade500)),
                      ],
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
