import {
	AbsoluteFill,
	interpolate,
	useCurrentFrame,
	useVideoConfig,
	Img,
	staticFile,
	Audio,
	Easing,
} from 'remotion';
import React from 'react';

export const Shot13: React.FC = () => {
	const frame = useCurrentFrame();
	const {durationInFrames} = useVideoConfig();

	// Timeline scaling: 5.33s total
	// Couple silhouette separation progress
	const progress = interpolate(frame, [0, durationInFrames], [0, 1], {
		easing: Easing.inOut(Easing.quad),
	});

	// Separation: one moves left, one moves right
	const leftOffset = interpolate(progress, [0, 1], [0, -40]);
	const rightOffset = interpolate(progress, [0, 1], [0, 40]);
	const silhouetteOpacity = interpolate(progress, [0, 0.2, 1], [0, 0.6, 0.4]);

	return (
		<AbsoluteFill style={{backgroundColor: '#001a33'}}>
			{/* Hourglass Background */}
			<AbsoluteFill>
				<Img
					src={staticFile('hourglass_separation.png')}
					style={{
						width: '100%',
						height: '100%',
						objectFit: 'cover',
						filter: 'saturate(0.5) brightness(0.8)',
					}}
				/>
			</AbsoluteFill>

			{/* Double Exposure: Couple Silhouette Separation */}
			<AbsoluteFill className="justify-center items-center" style={{opacity: silhouetteOpacity}}>
				<div className="relative w-full h-full flex justify-center items-center">
					{/* Left person */}
					<div 
						className="w-40 h-80 bg-black absolute"
						style={{
							transform: `translateX(${leftOffset}px)`,
							maskImage: 'linear-gradient(to bottom, black 80%, transparent)',
							borderRadius: '40% 40% 20% 20%',
							filter: 'blur(2px)',
						}}
					/>
					{/* Right person */}
					<div 
						className="w-40 h-80 bg-black absolute"
						style={{
							transform: `translateX(${rightOffset}px)`,
							maskImage: 'linear-gradient(to bottom, black 80%, transparent)',
							borderRadius: '40% 40% 20% 20%',
							filter: 'blur(2px)',
						}}
					/>
				</div>
			</AbsoluteFill>

			{/* Melancholic Blue Tone Overlay */}
			<AbsoluteFill
				style={{
					backgroundColor: 'rgba(0, 50, 150, 0.3)',
					mixBlendMode: 'color',
					pointerEvents: 'none',
				}}
			/>
			<AbsoluteFill
				style={{
					background: 'radial-gradient(circle, transparent, rgba(0, 10, 30, 0.6))',
					pointerEvents: 'none',
				}}
			/>

			{/* Overlay Text */}
			<AbsoluteFill className="justify-end items-center pb-24">
				<h2 
					className="text-white text-5xl font-light tracking-widest uppercase italic"
					style={{
						fontFamily: 'Inter, sans-serif',
						textShadow: '0 0 15px rgba(0, 100, 255, 0.8)',
					}}
				>
					тридцать дней раздумий
				</h2>
			</AbsoluteFill>

			<Audio src={staticFile('shot13_voice.mp3')} />
		</AbsoluteFill>
	);
};
